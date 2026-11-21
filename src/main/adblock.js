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
// - The engine is compiled in a short-lived utility process (adblock-build.js)
//   and written to disk in its compact serialized form; this process only
//   ever loads that form. Compiling in here would leave the browser holding
//   well over 100 MB more for the rest of the session (the lists as text and
//   every filter as an object), and it happens on first run and every 6 hours.
// - Startup loads the cached engine (about 30 ms) and never waits on the network
//   after the first run; lists refresh every few hours in the background.
const fs = require('fs');
const path = require('path');
const { app, ipcMain, utilityProcess } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { parse: parseDomain } = require('tldts-experimental');
const sites = require('./sites');

const REFRESH_MS = 6 * 60 * 60 * 1000;
const PRELOAD = path.join(__dirname, '..', 'preload', 'adblock.js');
const BUILDER = path.join(__dirname, 'adblock-build.js');
// uBO's scriptlet library, converted from uBO's own source at its latest
// stable release by scripts/build-scriptlets.js and shipped with the app.
// Third-party mirrors lag months behind the lists, and YouTube rules rely on
// the newest scriptlet features, so a stale library breaks (and slows) YouTube.
const RESOURCES_FILE = path.join(__dirname, 'ubo-resources.json');
/** The scriptlet library and its version tag (read when needed, not kept: it's 300 KB). */
function resources() {
  const text = fs.readFileSync(RESOURCES_FILE, 'utf8');
  const { ubo, built } = JSON.parse(text);
  return { text, checksum: `ubo-${ubo}-${built}` };
}

let engine = null;
const attached = new Set(); // sessions with blocking hooks installed
let enabled = false;
let refreshTimer = null;
let onBlocked = () => {};
let building = null;

const cacheFile = () => path.join(app.getPath('userData'), 'adblock', 'engine.bin');





function loadCache() {
  try {
    const buf = fs.readFileSync(cacheFile());
    return { engine: ElectronBlocker.deserialize(new Uint8Array(buf)), age: Date.now() - fs.statSync(cacheFile()).mtimeMs };
  } catch {
    return null;
  }
}


// One handler, so the engine being replaced can drop it (Ghostery's emitter
// has on / unsubscribe, no removeAllListeners).
const reportBlocked = (req) => onBlocked(req.tabId);

function install(next) {
  if (engine) engine.unsubscribe('request-blocked', reportBlocked);
  next.on('request-blocked', reportBlocked);
  engine = next;
}

/** Compile fresh lists in a utility process; resolves when the new engine.bin is written. */
function buildInWorker() {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(BUILDER, [cacheFile(), RESOURCES_FILE], { serviceName: 'Coffee ad-block lists', stdio: 'ignore' });
    let result = null;
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, 3 * 60 * 1000);
    child.on('message', (m) => { result = m; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (result && result.ok) resolve();
      else reject(new Error((result && result.error) || `builder exited with code ${code}`));
    });
  });
}

/** Download fresh lists and swap the engine in without interrupting browsing. */
function refresh() {
  if (building) return building;
  building = buildInWorker()
    .then(() => {
      const fresh = loadCache();
      if (!fresh) throw new Error('the new engine could not be read');
      if (enabled) install(fresh.engine); // turned off meanwhile: it's on disk for next time
    })
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
  if (!on) {
    // Off: let the engine go (it's reloaded from disk in a few ms when turned back on).
    if (engine) engine.unsubscribe('request-blocked', reportBlocked);
    engine = null;
    clearInterval(refreshTimer);
    refreshTimer = null;
    return;
  }
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
