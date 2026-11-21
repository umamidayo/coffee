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

// Outside the http(s)-only fixes above: local files can be saved too.
(() => {
  // --- Alt+click a link: open it in Glance (a floating preview) --------------
  // (Like Zen browser.) Only real clicks; an editable field keeps Alt+click.
  if (location.protocol !== 'coffee:') addEventListener('click', (e) => {
    if (!e.isTrusted || e.button !== 0 || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const a = e.composedPath().find((n) => n && n.tagName === 'A' && n.href);
    if (!a || !/^https?:/i.test(a.href) || a.isContentEditable) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const r = a.getBoundingClientRect();
    // Glance grows from the link (in the top page's coordinates when this is a frame).
    const rect = window === top ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
    ipcRenderer.send('glance:open', { url: a.href, rect });
  }, true);

  // --- Ctrl+S: the page first, like Chrome ------------------------------------
  // Web apps (editors, design tools) use Ctrl+S for their own Save. Only when
  // the page leaves it alone does the browser open Save page as. Registered at
  // document start, so it runs before the page's own listeners; the check
  // waits until they've all had their turn. Only real key presses count, so a
  // page can't open the save dialog with a synthetic event.
  if (location.protocol !== 'coffee:') addEventListener('keydown', (e) => {
    if (!e.isTrusted || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 's') return;
    setTimeout(() => { if (!e.defaultPrevented) ipcRenderer.send('page:save-shortcut'); });
  });
})();
