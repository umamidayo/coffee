'use strict';
// Download tracking. Files go straight into the download folder (no dialog),
// with Chrome-style "name (1).ext" de-duplication.
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const Store = require('./store');

const store = new Store('downloads', [], 1000);
const items = new Map(); // id -> live DownloadItem
let seq = Date.now();
let onChange = () => {};
let throttle = null;

// Anything left "progressing" from a previous run was interrupted.
for (const d of store.data) if (d.state === 'progressing') d.state = 'interrupted';

function list() {
  return store.data;
}

function changed() {
  if (throttle) return;
  throttle = setTimeout(() => {
    throttle = null;
    store.save();
    onChange(summary());
  }, 120);
}

function summary() {
  const active = store.data.filter((d) => d.state === 'progressing');
  let total = 0;
  let received = 0;
  for (const d of active) {
    total += d.total;
    received += d.received;
  }
  return {
    active: active.length,
    progress: active.length && total ? received / total : active.length ? -1 : 0,
    items: store.data,
  };
}

function uniquePath(dir, filename) {
  const safe = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download';
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let p = path.join(dir, safe);
  for (let i = 1; fs.existsSync(p) || [...items.values()].some((it) => it.getSavePath() === p); i++) {
    p = path.join(dir, `${base} (${i})${ext}`);
  }
  return p;
}

function attach(ses, getDir, notify, onStart) {
  onChange = notify;
  ses.on('will-download', (_e, item, wc) => {
    const dir = getDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const savePath = uniquePath(dir, item.getFilename());
    item.setSavePath(savePath);

    const id = String(seq++);
    const entry = {
      id,
      filename: path.basename(savePath),
      path: savePath,
      url: item.getURL(),
      total: item.getTotalBytes(),
      received: 0,
      state: 'progressing',
      paused: false,
      started: Date.now(),
      speed: 0,
    };
    items.set(id, item);
    store.data.unshift(entry);
    if (store.data.length > 200) store.data.length = 200;

    let lastBytes = 0;
    let lastTime = Date.now();
    item.on('updated', (_ev, state) => {
      const now = Date.now();
      entry.received = item.getReceivedBytes();
      entry.total = item.getTotalBytes();
      entry.paused = item.isPaused();
      entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      if (now - lastTime >= 500) {
        entry.speed = ((entry.received - lastBytes) * 1000) / (now - lastTime);
        lastBytes = entry.received;
        lastTime = now;
      }
      changed();
    });
    item.once('done', (_ev, state) => {
      entry.state = state; // completed | cancelled | interrupted
      entry.received = item.getReceivedBytes();
      entry.speed = 0;
      items.delete(id);
      changed();
    });
    changed();
    onStart(entry, wc);
  });
}

function action(id, what) {
  const entry = store.data.find((d) => d.id === id);
  const item = items.get(id);
  switch (what) {
    case 'open':
      if (entry && entry.state === 'completed') shell.openPath(entry.path);
      break;
    case 'show':
      if (entry) shell.showItemInFolder(entry.path);
      break;
    case 'pause':
      if (item) item.pause();
      break;
    case 'resume':
      if (item && item.canResume()) item.resume();
      break;
    case 'cancel':
      if (item) item.cancel();
      break;
    case 'remove':
      if (item) item.cancel();
      store.data = store.data.filter((d) => d.id !== id);
      break;
    case 'clear':
      store.data = store.data.filter((d) => d.state === 'progressing');
      break;
    default:
      return;
  }
  changed();
}

module.exports = { attach, list, summary, action };
