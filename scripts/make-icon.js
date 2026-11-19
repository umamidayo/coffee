'use strict';
// Renders build/icon.svg to build/icon.png (512) and a multi-size build/icon.ico.
// Run with: npm run icon
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const BUILD = path.join(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function render(size) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: size, height: size, show: false, frame: false, transparent: true,
      useContentSize: true,
      webPreferences: { offscreen: true },
    });
    win.webContents.setFrameRate(1);
    const html = `<html><body style="margin:0;background:transparent;overflow:hidden">
      <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block" onload="setTimeout(()=>document.title='ready',50)"></body></html>`;
    let done = false;
    let ready = false;
    win.webContents.on('page-title-updated', (_e, t) => {
      if (t === 'ready') { ready = true; win.webContents.invalidate(); }
    });
    win.webContents.on('paint', (_e, _dirty, image) => {
      if (done || !ready) return;
      const s = image.getSize();
      if (s.width < size) return;
      done = true;
      resolve(image.resize({ width: size, height: size, quality: 'best' }).toPNG());
      setTimeout(() => win.destroy(), 0);
    });
    win.webContents.on('did-fail-load', reject);
    win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  });
}

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, buf }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const big = await render(512);
  fs.writeFileSync(path.join(BUILD, 'icon.png'), big);
  const pngs = [];
  // Tiny windows don't render reliably offscreen, so downscale a large render.
  const hi = nativeImage.createFromBuffer(big);
  for (const size of ICO_SIZES) {
    pngs.push({ size, buf: hi.resize({ width: size, height: size, quality: 'best' }).toPNG() });
  }
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico(pngs));
  console.log('Wrote build/icon.png and build/icon.ico');
  app.quit();
});
