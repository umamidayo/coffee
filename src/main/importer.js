'use strict';
// Import bookmarks and history from Chromium-based browsers (Chrome, Edge,
// Brave, Vivaldi). Their profiles share one format: a JSON "Bookmarks" file
// and SQLite "History" / "Favicons" databases. The databases are copied to a
// temp folder first, so the source browser can stay open and is never written
// to. Cookies and passwords can't be imported: Chromium encrypts them with
// keys only the original browser can use.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const data = require('./data');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', dir: path.join(LOCAL, 'Google', 'Chrome', 'User Data') },
  { id: 'edge', name: 'Microsoft Edge', dir: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data') },
  { id: 'brave', name: 'Brave', dir: path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data') },
  { id: 'vivaldi', name: 'Vivaldi', dir: path.join(LOCAL, 'Vivaldi', 'User Data') },
];
const HISTORY_LIMIT = 4000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Installed browsers and their profiles: [{ id, name, profiles: [{ dir, name }] }]. */
function detect() {
  const out = [];
  for (const b of BROWSERS) {
    if (!fs.existsSync(b.dir)) continue;
    const cache = (readJson(path.join(b.dir, 'Local State')) || {}).profile?.info_cache || {};
    const profiles = [];
    let dirs = [];
    try { dirs = fs.readdirSync(b.dir); } catch { /* unreadable */ }
    for (const dir of dirs) {
      if (!/^(Default|Profile \d+)$/.test(dir)) continue;
      const p = path.join(b.dir, dir);
      if (!fs.existsSync(path.join(p, 'Bookmarks')) && !fs.existsSync(path.join(p, 'History'))) continue;
      profiles.push({ dir, name: (cache[dir] && cache[dir].name) || dir });
    }
    if (profiles.length) out.push({ id: b.id, name: b.name, profiles });
  }
  return out;
}

/** Copy a SQLite database (plus its journal/WAL) somewhere we can open it. */
function copyDb(src, tmp) {
  const dest = path.join(tmp, path.basename(src));
  fs.copyFileSync(src, dest);
  for (const ext of ['-wal', '-journal']) {
    if (fs.existsSync(src + ext)) { try { fs.copyFileSync(src + ext, dest + ext); } catch { /* optional */ } }
  }
  return dest;
}

function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

/** Favicon lookup from the browser's Favicons database (page URL -> data URL). */
function faviconReader(profileDir, tmp) {
  const src = path.join(profileDir, 'Favicons');
  if (!fs.existsSync(src)) return { get: () => '', close() {} };
  let db;
  try { db = openDb(copyDb(src, tmp)); } catch { return { get: () => '', close() {} }; }
  const stmt = db.prepare(`
    SELECT b.image_data AS img FROM icon_mapping m
    JOIN favicon_bitmaps b ON b.icon_id = m.icon_id
    WHERE m.page_url = ? AND b.image_data IS NOT NULL
    ORDER BY ABS(b.width - 32) LIMIT 1`);
  return {
    get(url) {
      try {
        const row = stmt.get(url);
        return row && row.img ? `data:image/png;base64,${Buffer.from(row.img).toString('base64')}` : '';
      } catch { return ''; }
    },
    close() { try { db.close(); } catch { /* ignore */ } },
  };
}

function importBookmarks(profileDir, icons, browserName) {
  const file = readJson(path.join(profileDir, 'Bookmarks'));
  if (!file || !file.roots) return { bookmarks: 0, folders: 0 };
  let bookmarks = 0;
  const created = []; // folders made by this import
  const walk = (nodes, parent) => {
    for (const n of nodes || []) {
      if (n.type === 'url' && /^https?:/i.test(n.url || '')) {
        if (data.findBookmark(n.url)) continue; // already bookmarked
        data.addBookmark({ url: n.url, title: n.name || n.url, favicon: icons.get(n.url), parent });
        bookmarks++;
      } else if (n.type === 'folder') {
        const f = data.addFolder(n.name || 'Folder', parent);
        created.push(f.id);
        walk(n.children, f.id);
      }
    }
  };
  // If Coffee's bar is empty, the browser's bar becomes the bar; otherwise
  // everything goes into one folder so nothing gets mixed up.
  const barEmpty = data.children(null).length === 0;
  let root = null;
  if (!barEmpty) { root = data.addFolder(`From ${browserName}`, null).id; created.push(root); }
  const { bookmark_bar: bar, other, synced } = file.roots;
  walk(bar && bar.children, root);
  for (const [node, title] of [[other, 'Other bookmarks'], [synced, 'Mobile bookmarks']]) {
    if (node && node.children && node.children.length) {
      const f = data.addFolder(title, root);
      created.push(f.id);
      walk(node.children, f.id);
    }
  }
  // Folders that ended up empty (everything inside was already bookmarked,
  // e.g. importing twice) are removed again, innermost first.
  let folders = created.length;
  for (const id of created.reverse()) {
    if (data.children(id).length === 0) { data.removeBookmark(id); folders--; }
  }
  return { bookmarks, folders };
}

function importHistory(profileDir, tmp, icons) {
  const src = path.join(profileDir, 'History');
  if (!fs.existsSync(src)) return 0;
  const db = openDb(copyDb(src, tmp));
  try {
    const rows = db.prepare(`
      SELECT url, title, visit_count AS visits, last_visit_time / 1000 AS t FROM urls
      WHERE hidden = 0 AND last_visit_time > 0 AND (url LIKE 'http://%' OR url LIKE 'https://%')
      ORDER BY last_visit_time DESC LIMIT ?`).all(HISTORY_LIMIT);
    // Chromium time is microseconds since 1601-01-01 (UTC), too large for a JS
    // number, so the query divides to milliseconds; shift to the Unix epoch.
    const toMs = (t) => Math.round(Number(t) - 11644473600000);
    // Favicons for the most-visited pages (used by new tab shortcuts).
    const top = new Set([...rows].sort((a, b) => b.visits - a.visits).slice(0, 150).map((r) => r.url));
    return data.importHistory(rows.map((r) => ({
      url: r.url,
      title: r.title || '',
      visits: Math.max(1, Number(r.visits) || 1),
      last: toMs(r.t),
      favicon: top.has(r.url) ? icons.get(r.url) : '',
    })));
  } finally {
    db.close();
  }
}

/**
 * Import from one browser profile.
 * @returns {{ ok: boolean, bookmarks?, folders?, history?, error? }}
 */
function run({ browser, profile, bookmarks = true, history = true }) {
  const b = detect().find((x) => x.id === browser);
  const p = b && b.profiles.find((x) => x.dir === profile);
  if (!p) return { ok: false, error: 'That browser profile could not be found.' };
  const profileDir = path.join(BROWSERS.find((x) => x.id === browser).dir, p.dir);
  const tmp = fs.mkdtempSync(path.join(app.getPath('temp'), 'coffee-import-'));
  const result = { ok: true, bookmarks: 0, folders: 0, history: 0 };
  const icons = faviconReader(profileDir, tmp);
  try {
    if (bookmarks) Object.assign(result, importBookmarks(profileDir, icons, b.name));
    if (history) result.history = importHistory(profileDir, tmp, icons);
  } catch (err) {
    const busy = /EBUSY|locked|EPERM/i.test(String(err && (err.code || err.message)));
    return { ...result, ok: false, error: busy ? `Close ${b.name} and try again.` : `Import failed: ${err.message}` };
  } finally {
    icons.close();
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
  return result;
}

module.exports = { detect, run };
