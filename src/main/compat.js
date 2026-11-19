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
const { ipcMain } = require('electron');

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
}

module.exports = { setup, SIGNIN_HOSTS };
