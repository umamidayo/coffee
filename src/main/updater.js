'use strict';
// Automatic updates from GitHub Releases (configured under "publish" in
// package.json). Updates download quietly in the background; the browser
// shows a small "Restart to update" button, and anything left pending
// installs the next time Coffee quits.
const { app } = require('electron');

const CHECK_EVERY = 4 * 60 * 60 * 1000;
let autoUpdater = null;
let status = { state: 'idle', version: null, progress: 0, error: null };
let notify = () => {};

function set(patch) {
  status = { ...status, ...patch };
  notify(status);
}

function init(onStatus) {
  notify = onStatus;
  // Only an installed build can update itself.
  if (!app.isPackaged) {
    set({ state: 'dev' });
    return;
  }
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, progress: 0 }));
  autoUpdater.on('update-not-available', () => set({ state: 'latest' }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', progress: p.percent / 100 }));
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version, progress: 1 }));
  autoUpdater.on('error', (err) => {
    const msg = String((err && err.message) || err);
    // No release published yet (or repo not public yet): nothing to update to.
    if (/\b404\b|No published versions|Unable to find latest version/i.test(msg)) return set({ state: 'latest', error: null });
    set({ state: 'error', error: msg.split('\n')[0] });
  });

  setTimeout(check, 8000);
  setInterval(check, CHECK_EVERY);
}

function check() {
  if (!autoUpdater || status.state === 'downloading' || status.state === 'ready') return;
  autoUpdater.checkForUpdates().catch(() => {});
}

function install() {
  if (autoUpdater && status.state === 'ready') autoUpdater.quitAndInstall(true, true);
}

module.exports = { init, check, install, get status() { return status; } };
