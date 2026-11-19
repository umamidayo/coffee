'use strict';
// Runs at document start in every web frame. Small, targeted fixes injected
// into the page's own JavaScript world (world 0) before any page script runs.
const { ipcRenderer, webFrame } = require('electron');

(() => {
  if (!/^https?:/.test(location.protocol)) return;

  // --- Passkey autofill ------------------------------------------------------
  // Login pages (Google, Amazon, Twitch, Roblox...) ask for passkey *autofill*
  // via navigator.credentials.get({ mediation: 'conditional' }). Chrome shows
  // that inside its own username dropdown; Electron has no such UI and hands it
  // straight to Windows, which pops a "Windows Security" dialog on every login
  // page. Report autofill as unavailable and let conditional requests wait
  // silently (until the page aborts them), exactly like a browser without the
  // feature. Explicit passkey sign-in still goes to Windows Hello as normal.
  const scripts = [];
  scripts.push(`(() => {
    const PKC = window.PublicKeyCredential;
    if (PKC) {
      if (PKC.isConditionalMediationAvailable) {
        Object.defineProperty(PKC, 'isConditionalMediationAvailable', {
          value: function isConditionalMediationAvailable() { return Promise.resolve(false); },
          configurable: true, writable: true,
        });
      }
      if (PKC.getClientCapabilities) {
        const caps = PKC.getClientCapabilities;
        Object.defineProperty(PKC, 'getClientCapabilities', {
          value: function getClientCapabilities() {
            return caps.call(PKC).then((c) => Object.assign({}, c, { conditionalGet: false, conditionalCreate: false }));
          },
          configurable: true, writable: true,
        });
      }
    }
    const CC = window.CredentialsContainer && CredentialsContainer.prototype;
    if (CC && CC.get) {
      const get = CC.get;
      Object.defineProperty(CC, 'get', {
        value: function get(options) {
          if (options && options.mediation === 'conditional' && options.publicKey) {
            return new Promise((resolve, reject) => {
              const signal = options.signal;
              if (!signal) return;
              if (signal.aborted) { reject(signal.reason); return; }
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          }
          return get.apply(this, arguments);
        },
        configurable: true, writable: true,
      });
    }
  })();`);

  // --- Google sign-in identity -------------------------------------------------
  // On Google's sign-in hosts, main/compat.js sends Electron's honest user
  // agent; make navigator.userAgent / appVersion say the same thing. Nothing
  // else is touched: client hints, vendor, etc. are already genuine Chromium.
  if (location.hostname === 'accounts.google.com' || location.hostname === 'accounts.youtube.com') {
    let id = null;
    try { id = ipcRenderer.sendSync('compat:identity'); } catch { /* ignore */ }
    if (id) {
      scripts.push(`(() => {
        const N = Navigator.prototype;
        const ua = ${JSON.stringify(id.ua)};
        Object.defineProperty(N, 'userAgent', { get: () => ua, configurable: true, enumerable: true });
        const appVersion = ua.startsWith('Mozilla/') ? ua.slice(8) : ua;
        Object.defineProperty(N, 'appVersion', { get: () => appVersion, configurable: true, enumerable: true });
      })();`);
    }
  }

  // Separate sources, compiled independently: one failing fix can't disable another.
  try { webFrame.executeJavaScriptInIsolatedWorld(0, scripts.map((code) => ({ code }))); } catch { /* ignore */ }
})();
