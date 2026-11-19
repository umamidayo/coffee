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
  let code = `(() => {
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
  })();`;

  // --- Google sign-in identity -------------------------------------------------
  // On Google's sign-in pages only, make navigator.* match the Firefox identity
  // that main/compat.js sends in the request headers.
  if (location.hostname === 'accounts.google.com') {
    let id = null;
    try { id = ipcRenderer.sendSync('compat:identity'); } catch { /* ignore */ }
    if (id) {
      code += `(() => {
        const N = Navigator.prototype;
        const def = (k, v) => Object.defineProperty(N, k, { get: () => v, configurable: true, enumerable: true });
        def('userAgent', ${JSON.stringify(id.ua)});
        def('appVersion', '5.0 (Windows)');
        def('platform', 'Win32');
        def('vendor', '');
        def('productSub', '20100101');
        def('oscpu', 'Windows NT 10.0; Win64; x64');
        def('buildID', '20181001000000');
        try { delete N.userAgentData; } catch (e) {}
      })();`;
    }
  }

  try { webFrame.executeJavaScriptInIsolatedWorld(0, [{ code }]); } catch { /* ignore */ }
})();
