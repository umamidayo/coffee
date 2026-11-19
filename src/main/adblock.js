'use strict';
// Ad & tracker blocking with uBlock Origin's own filter lists and scriptlets.
//
// - Lists come straight from uBO's asset servers (the same defaults uBO ships:
//   uBlock filters + quick fixes, badware, privacy, unbreak, resource abuse,
//   EasyList, EasyPrivacy, Peter Lowe), with uBO's `!#include` and `!#if`
//   directives resolved for a Chromium environment.
// - Scriptlets (`##+js(...)`) are uBO's scriptlet library and are injected
//   synchronously at document start in every frame (see preload/adblock.js).
//   That timing is what defeats YouTube-style in-player ads.
// - The compiled engine is cached on disk and refreshed every few hours in
//   the background, so startup never waits on the network after the first run.
const fs = require('fs');
const path = require('path');
const { app, ipcMain } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { parse: parseDomain } = require('tldts-experimental');
const sites = require('./sites');

const REFRESH_MS = 6 * 60 * 60 * 1000;
const PRELOAD = path.join(__dirname, '..', 'preload', 'adblock.js');

// Mirrors are tried in order, like uBO's cdnURLs.
const UBO = ['https://ublockorigin.github.io/uAssets/', 'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@latest/', 'https://ublockorigin.pages.dev/'];
const LISTS = [
  ...['filters/filters.txt', 'filters/quick-fixes.txt', 'filters/badware.txt', 'filters/privacy.txt',
    'filters/unbreak.txt', 'filters/resource-abuse.txt', 'thirdparties/easylist.txt', 'thirdparties/easyprivacy.txt']
    .map((p) => UBO.map((base) => base + p)),
  ['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
    'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/peter-lowe/serverlist.txt'],
];
// uBO's scriptlet library, converted from uBO's own source at its latest
// stable release by scripts/build-scriptlets.js and shipped with the app.
// Third-party mirrors lag months behind the lists, and YouTube rules rely on
// the newest scriptlet features, so a stale library breaks (and slows) YouTube.
const RESOURCES_FILE = path.join(__dirname, 'ubo-resources.json');
let resourcesCache = null;
function resources() {
  if (!resourcesCache) {
    const text = fs.readFileSync(RESOURCES_FILE, 'utf8');
    const { ubo, built } = JSON.parse(text);
    resourcesCache = { text, checksum: `ubo-${ubo}-${built}` };
  }
  return resourcesCache;
}

// The environment uBO's `!#if` blocks are evaluated against.
const ENV = { env_chromium: true, cap_user_stylesheet: true, ext_ublock: true, ext_ubol: false, env_mv3: false,
  env_firefox: false, env_edge: false, env_safari: false, env_mobile: false, env_legacy: false, cap_html_filtering: false,
  adguard: false, adguard_app_windows: false, adguard_ext_chromium: false, false: false, true: true };

const CONFIG = { loadCosmeticFilters: true, loadNetworkFilters: true, loadGenericCosmeticsFilters: true,
  enableMutationObserver: true, loadCSPFilters: true, enableHtmlFiltering: false, loadExtendedSelectors: false,
  guessRequestTypeFromUrl: true };

let engine = null;
const attached = new Set(); // sessions with blocking hooks installed
let enabled = false;
let refreshTimer = null;
let onBlocked = () => {};
let building = null;

const cacheFile = () => path.join(app.getPath('userData'), 'adblock', 'engine.bin');

// ---------------------------------------------------------------------------
// Fetching & preprocessing lists
// ---------------------------------------------------------------------------

async function fetchText(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return { text: await res.text(), url };
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

/** Evaluate a uBO `!#if` expression: identifiers, !, &&, ||, parentheses. */
function evalCondition(expr) {
  const tokens = expr.match(/!|&&|\|\||\(|\)|[\w-]+/g) || [];
  let i = 0;
  const primary = () => {
    const t = tokens[i++];
    if (t === '!') return !primary();
    if (t === '(') { const v = or(); i++; return v; }
    return !!ENV[t];
  };
  const and = () => { let v = primary(); while (tokens[i] === '&&') { i++; v = primary() && v; } return v; };
  const or = () => { let v = and(); while (tokens[i] === '||') { i++; v = and() || v; } return v; };
  return or();
}

/** Resolve `!#include` (fetched relative to the list) and drop inactive `!#if` blocks. */
async function preprocess(text, baseUrl, depth = 0) {
  const out = [];
  const stack = []; // each entry: is the current block active?
  const active = () => stack.every(Boolean);
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('!#if ')) { stack.push(evalCondition(line.slice(5))); continue; }
    if (line.startsWith('!#else')) { if (stack.length) stack.push(!stack.pop()); continue; }
    if (line.startsWith('!#endif')) { stack.pop(); continue; }
    if (!active()) continue;
    if (line.startsWith('!#include ') && depth < 3) {
      const rel = line.slice(10).trim();
      const url = new URL(rel, baseUrl);
      // Only follow includes on the same origin as the list (uBO's rule).
      if (url.origin !== new URL(baseUrl).origin) continue;
      try {
        const sub = await fetchText([url.href]);
        out.push(await preprocess(sub.text, sub.url, depth + 1));
      } catch { /* skip a missing sub-list */ }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

async function build() {
  const results = await Promise.allSettled(LISTS.map(async (mirrors) => {
    const { text, url } = await fetchText(mirrors);
    return preprocess(text, url);
  }));
  const lists = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (lists.length < LISTS.length / 2) throw new Error('Too many filter lists failed to download');
  const next = ElectronBlocker.parse(lists.join('\n'), CONFIG);
  const res = resources();
  next.updateResources(res.text, res.checksum);
  return next;
}

function loadCache() {
  try {
    const buf = fs.readFileSync(cacheFile());
    return { engine: ElectronBlocker.deserialize(new Uint8Array(buf)), age: Date.now() - fs.statSync(cacheFile()).mtimeMs };
  } catch {
    return null;
  }
}

function saveCache(e) {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    const tmp = `${cacheFile()}.tmp`;
    fs.writeFileSync(tmp, e.serialize());
    fs.renameSync(tmp, cacheFile());
  } catch (err) { console.error('Adblock cache write failed:', err); }
}

function install(next) {
  next.on('request-blocked', (req) => onBlocked(req.tabId));
  engine = next;
}

/** Download fresh lists and swap the engine in without interrupting browsing. */
function refresh() {
  if (building) return building;
  building = build()
    .then((next) => { install(next); saveCache(next); })
    .catch((err) => console.error('Adblock refresh failed:', err.message))
    .finally(() => { building = null; });
  return building;
}

// ---------------------------------------------------------------------------
// Wiring into the session
// ---------------------------------------------------------------------------

// Sites the user turned blocking off for. Matches subdomains too.
let exceptions = [];

function setExceptions(list) {
  exceptions = (Array.isArray(list) ? list : []).map(sites.normalizeHost).filter(Boolean);
}

function exempt(url) {
  if (!exceptions.length) return false;
  const host = sites.hostOf(url);
  return !!host && exceptions.some((s) => sites.matches(host, s));
}

/** The page a request belongs to: the destination itself for a navigation, else the tab's current page. */
function pageOf(details) {
  if (details.resourceType === 'mainFrame') return details.url;
  try {
    const wc = details.webContents;
    if (wc && !wc.isDestroyed()) return wc.getURL();
  } catch { /* fall through */ }
  return details.url;
}

/** The top-level page for an IPC sender (an iframe's own URL isn't the page the user is on). */
function topUrl(e, url) {
  try {
    if (e.senderFrame && e.senderFrame.top) return e.senderFrame.top.url || url;
  } catch { /* fall through */ }
  return url;
}

function cosmetics(url, features, top = url) {
  if (!enabled || !engine || !/^https?:/.test(url) || exempt(top)) return null;
  const parsed = parseDomain(url);
  const first = !features;
  return engine.getCosmeticsFilters({
    url,
    hostname: parsed.hostname || '',
    domain: parsed.domain || '',
    classes: features && features.classes,
    hrefs: features && features.hrefs,
    ids: features && features.ids,
    getBaseRules: first,
    getInjectionRules: first,
    getExtendedRules: false,
    getRulesFromHostname: first,
    getRulesFromDOM: !first,
  });
}

// The engine passes every scriptlet argument through decodeURIComponent, which
// throws on a literal "%" (uBO's YouTube `prevent-xhr` rule for the /atr
// attestation ping contains one), silently disabling that scriptlet. Decode
// leniently instead: fall back to the raw argument like uBO does.
const STRICT_DECODE = '.map((a) => decodeURIComponent(a))';
const LENIENT_DECODE = '.map((a) => { try { return decodeURIComponent(a); } catch (_) { return a; } })';
function fixScriptlet(script) {
  return script.includes(STRICT_DECODE) ? script.split(STRICT_DECODE).join(LENIENT_DECODE) : script;
}

ipcMain.on('adblock:start', (e, url) => {
  try {
    const u = String(url || '');
    const r = cosmetics(u, undefined, topUrl(e, u));
    e.returnValue = r && r.active ? { styles: r.styles, scripts: r.scripts.map(fixScriptlet), observe: engine.config.enableMutationObserver } : null;
  } catch {
    e.returnValue = null;
  }
});

ipcMain.handle('adblock:dom', (e, url, features) => {
  const u = String(url || '');
  const r = cosmetics(u, {
    classes: Array.isArray(features && features.classes) ? features.classes.slice(0, 2000) : [],
    ids: Array.isArray(features && features.ids) ? features.ids.slice(0, 2000) : [],
    hrefs: Array.isArray(features && features.hrefs) ? features.hrefs.slice(0, 2000) : [],
  }, topUrl(e, u));
  return r && r.active ? r.styles : '';
});

/** Install the blocking hooks on a session (normal or private). Idempotent. */
function attach(ses) {
  if (!ses || attached.has(ses)) return;
  attached.add(ses);
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
    if (enabled && engine && !exempt(pageOf(d))) engine.onBeforeRequest(d, cb);
    else cb({});
  });
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => {
    if (enabled && engine && !exempt(pageOf(d))) engine.onHeadersReceived(d, cb);
    else cb({});
  });
  ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD });
}

/**
 * Turn blocking on/off. Resolves once an engine is ready (from cache, or a
 * first-run download).
 */
async function setEnabled(session, on, blockedCb) {
  if (blockedCb) onBlocked = blockedCb;
  attach(session);
  enabled = !!on;
  if (!on) return;
  if (!engine) {
    // Engine file from older builds (Ghostery's prebuilt lists).
    fs.rm(path.join(app.getPath('userData'), 'adblock-engine.bin'), { force: true }, () => {});
    const cached = loadCache();
    if (cached) {
      // A newer app build may ship a newer uBO scriptlet library.
      const res = resources();
      if (cached.engine.resources.checksum !== res.checksum) cached.engine.updateResources(res.text, res.checksum);
      install(cached.engine);
      if (cached.age > REFRESH_MS) setTimeout(refresh, 15000);
    } else {
      await refresh();
    }
  }
  if (!refreshTimer) refreshTimer = setInterval(refresh, REFRESH_MS);
}

module.exports = { setEnabled, setExceptions, refresh, attach };
