'use strict';
// Runs at document start in every frame; does nothing except on Google's
// sign-in pages, where it makes navigator.* match the Firefox identity that
// main/compat.js sends in the request headers.
const { ipcRenderer, webFrame } = require('electron');

(() => {
  if (location.hostname !== 'accounts.google.com') return;
  let id;
  try { id = ipcRenderer.sendSync('compat:identity'); } catch { return; }
  if (!id) return;

  const code = `(() => {
    const N = Navigator.prototype;
    const def = (k, v) => Object.defineProperty(N, k, { get: () => v, configurable: true, enumerable: true });
    def('userAgent', ${JSON.stringify(id.ua)});
    def('appVersion', '5.0 (Windows)');
    def('platform', 'Win32');
    def('vendor', '');
    def('productSub', '20100101');
    def('oscpu', 'Windows NT 10.0; Win64; x64');
    def('buildID', '20181001000000');
    // Firefox has no User-Agent Client Hints API.
    try { delete N.userAgentData; } catch (e) {}
  })();`;
  // World 0 = the page's own JavaScript world.
  try { webFrame.executeJavaScriptInIsolatedWorld(0, [{ code }]); } catch { /* ignore */ }
})();
