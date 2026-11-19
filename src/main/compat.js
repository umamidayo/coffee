'use strict';
// Site compatibility shims.
//
// Google sign-in ("This browser or app may not be secure"): Google rejects
// any browser identity that doesn't match what its scripts observe. Coffee
// presents a clean Chrome user agent everywhere (Electron/app tokens removed),
// and on Google's sign-in pages that disguise is exactly what gets rejected,
// as is a Firefox disguise. The honest identity passes: Electron's own,
// unmodified user agent with Chromium's own client hints. So on Google's
// sign-in hosts only, Coffee says what it really is. Every other site keeps
// the normal Chrome identity. See https://github.com/stablyai/orca/pull/36519
// for measurements of each variant.
const path = require('path');
const { app, ipcMain } = require('electron');

const SIGNIN_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com']);
const PRELOAD = path.join(__dirname, '..', 'preload', 'compat.js');

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

const sessions = new Set();
let honestUA = '';

/** Install the sign-in fixes on a session (normal or private). Idempotent. */
function attach(ses) {
  if (sessions.has(ses)) return;
  sessions.add(ses);
  ses.webRequest.onBeforeSendHeaders({ urls: [...SIGNIN_HOSTS].map((h) => `https://${h}/*`) }, (details, callback) => {
    const headers = details.requestHeaders;
    headers['User-Agent'] = honestUA; // client hints are left as Chromium sends them
    callback({ requestHeaders: headers });
  });
  ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD });
}

/** One-time setup. @param electronUA the untouched Electron user agent */
function setup(ses, electronUA) {
  honestUA = electronUA;

  // The page's navigator.userAgent must match the header.
  ipcMain.on('compat:identity', (e) => {
    const url = e.senderFrame ? e.senderFrame.url : '';
    e.returnValue = SIGNIN_HOSTS.has(hostOf(url)) ? { ua: honestUA } : null;
  });

  // Google remembers a rejection in the sign-in site's stored data, so a
  // profile rejected once (e.g. under an older Coffee) keeps being rejected.
  // When the rejection page shows up, wipe that data once and restart sign-in.
  app.on('web-contents-created', (_e, wc) => {
    wc.on('did-navigate', (_ev, url) => {
      if (sessions.has(wc.session) && /^https:\/\/accounts\.google\.com\/(v3\/)?signin\/rejected/.test(url)) recoverSignin(wc.session, wc);
    });
  });

  attach(ses);
}

let lastRecovery = 0;
async function recoverSignin(ses, wc) {
  if (Date.now() - lastRecovery < 10 * 60 * 1000) return; // once per 10 min: never loop
  lastRecovery = Date.now();
  try {
    await ses.clearStorageData({ origin: 'https://accounts.google.com' });
    await ses.clearStorageData({ origin: 'https://accounts.youtube.com' });
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

module.exports = { setup, attach, SIGNIN_HOSTS };
