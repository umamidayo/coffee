'use strict';
// Site compatibility shims.
//
// Google sign-in rejects embedded Chromium browsers ("This browser or app may
// not be secure") based on JavaScript checks that an Electron app cannot
// pass while presenting as Chrome. It does accept Firefox, so on Google's
// sign-in pages only, Coffee presents itself consistently as Firefox: the
// User-Agent header, no Chrome client-hint headers, and the matching
// navigator.* values in the page (via preload/compat.js). Cookies set during
// sign-in carry over, so every other Google site keeps the normal Chrome
// identity.
const path = require('path');
const { app, ipcMain } = require('electron');

const SIGNIN_HOSTS = new Set(['accounts.google.com']);
const PRELOAD = path.join(__dirname, '..', 'preload', 'compat.js');

// Track the engine's age so we never look like an outdated Firefox.
const major = process.versions.chrome.split('.')[0];
const FIREFOX_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`;

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function setup(ses) {
  ses.webRequest.onBeforeSendHeaders({ urls: [...SIGNIN_HOSTS].map((h) => `https://${h}/*`) }, (details, callback) => {
    const headers = details.requestHeaders;
    headers['User-Agent'] = FIREFOX_UA;
    for (const name of Object.keys(headers)) {
      if (/^sec-ch-ua/i.test(name)) delete headers[name];
    }
    callback({ requestHeaders: headers });
  });

  ipcMain.on('compat:identity', (e) => {
    const url = e.senderFrame ? e.senderFrame.url : '';
    e.returnValue = SIGNIN_HOSTS.has(hostOf(url)) ? { ua: FIREFOX_UA } : null;
  });

  ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD });

  // Google remembers a "not secure" verdict in the sign-in site's stored data
  // (cookies, local storage, IndexedDB, cache), so a profile that was rejected
  // once keeps being rejected. When the rejection page shows up, wipe
  // accounts.google.com's data once and restart the sign-in.
  app.on('web-contents-created', (_e, wc) => {
    wc.on('did-navigate', (_ev, url) => {
      if (wc.session === ses && /^https:\/\/accounts\.google\.com\/(v3\/)?signin\/rejected/.test(url)) recoverSignin(ses, wc);
    });
  });
}

let lastRecovery = 0;
async function recoverSignin(ses, wc) {
  if (Date.now() - lastRecovery < 10 * 60 * 1000) return; // once per 10 min: never loop
  lastRecovery = Date.now();
  try {
    await ses.clearStorageData({ origin: 'https://accounts.google.com' });
    await ses.clearCache();
  } catch { /* best effort */ }
  if (wc.isDestroyed()) return;
  // Go back to where the sign-in started (keeps the "continue" target).
  let restart = 'https://accounts.google.com/signin';
  try {
    const entries = wc.navigationHistory.getAllEntries();
    const start = entries.find((e) => /^https:\/\/accounts\.google\.com\//.test(e.url) && !/\/rejected/.test(e.url));
    if (start) restart = start.url;
  } catch { /* ignore */ }
  wc.loadURL(restart).catch(() => {});
}

module.exports = { setup, SIGNIN_HOSTS };
