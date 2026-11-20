'use strict';
// Renders the setup wizard's artwork from build/icon.svg:
//   build/installerSidebar.bmp    164 x 314  welcome and finish screens
//   build/uninstallerSidebar.bmp  164 x 314  uninstaller's welcome screen
//   build/installerHeader.bmp     150 x 57   top-right of the other screens
// electron-builder picks these up by name. Run with: npm run installer-art
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const BUILD = path.join(__dirname, '..', 'build');
const logo = `data:image/svg+xml;base64,${fs.readFileSync(path.join(BUILD, 'icon.svg')).toString('base64')}`;

// Coffee's default theme (src/main/themes.js): bg #17120e, surface #211a15,
// text #efe4d8, accent #c89b6d.
const FONT = "'Segoe UI Variable Display', 'Segoe UI', sans-serif"; // single quotes: it goes inside style="..."

const sidebar = (tagline) => `
  <div style="position:absolute;inset:0;overflow:hidden;
    background:
      radial-gradient(120px 120px at 82px 96px, rgba(200,155,109,.28), transparent 70%),
      radial-gradient(220px 160px at 0 314px, rgba(200,155,109,.14), transparent 70%),
      linear-gradient(180deg, #1d1611 0%, #17120e 55%, #130f0b 100%)">
    <svg width="164" height="314" style="position:absolute;inset:0" viewBox="0 0 164 314">
      <!-- a little steam above the cup -->
      <g fill="none" stroke="rgba(236,200,154,.20)" stroke-width="2" stroke-linecap="round">
        <path d="M70 36c-6 -8 6 -12 0 -20"/><path d="M82 32c-6 -8 6 -12 0 -20"/><path d="M94 36c-6 -8 6 -12 0 -20"/>
      </g>
    </svg>
    <img src="${logo}" style="position:absolute;left:46px;top:58px;width:72px;height:72px;
      filter:drop-shadow(0 8px 18px rgba(0,0,0,.45))">
    <div style="position:absolute;left:0;right:0;top:146px;text-align:center;
      font:600 26px/1 ${FONT};color:#efe4d8;letter-spacing:-.3px">Coffee</div>
    <div style="position:absolute;left:12px;right:12px;top:180px;text-align:center;
      font:400 12px/1.35 ${FONT};color:#b9a594">${tagline}</div>
    <div style="position:absolute;left:58px;right:58px;top:220px;height:2px;border-radius:2px;
      background:linear-gradient(90deg, transparent, #c89b6d, transparent);opacity:.8"></div>
  </div>`;

const header = `
  <div style="position:absolute;inset:0;background:#ffffff">
    <div style="position:absolute;right:46px;top:0;bottom:0;display:flex;align-items:center;
      font:600 17px/1 ${FONT};color:#3a2619;letter-spacing:-.2px">Coffee</div>
    <img src="${logo}" style="position:absolute;right:8px;top:12px;width:33px;height:33px">
  </div>`;

const ART = [
  { file: 'installerSidebar.bmp', width: 164, height: 314, html: sidebar('A fast, minimal browser.') },
  { file: 'uninstallerSidebar.bmp', width: 164, height: 314, html: sidebar('Thanks for trying Coffee.') },
  { file: 'installerHeader.bmp', width: 150, height: 57, html: header },
];

/** Render HTML at exactly width x height pixels (any screen scale is undone). */
function render({ width, height, html }) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width, height, show: false, frame: false, useContentSize: true,
      webPreferences: { offscreen: true },
    });
    const page = `<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;position:relative;overflow:hidden">${html}
      <script>Promise.all([...document.images].map((i) => i.decode())).then(() => document.fonts.ready).then(() => setTimeout(() => { document.title = 'ready'; }, 60));</script></body></html>`;
    let ready = false;
    let done = false;
    win.webContents.on('page-title-updated', (_e, t) => { if (t === 'ready') { ready = true; win.webContents.invalidate(); } });
    win.webContents.on('paint', (_e, _dirty, image) => {
      if (done || !ready || image.getSize().width < width) return;
      done = true;
      resolve(image.resize({ width, height, quality: 'best' }));
      setTimeout(() => win.destroy(), 0);
    });
    win.webContents.on('did-fail-load', reject);
    win.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
  });
}

/** A 24-bit, bottom-up Windows bitmap (what NSIS wants). */
function bmp(image) {
  const { width, height } = image.getSize();
  const bgra = image.toBitmap(); // BGRA, top row first
  const stride = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    const dst = (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      data[dst + x * 3] = bgra[src + x * 4];         // B
      data[dst + x * 3 + 1] = bgra[src + x * 4 + 1]; // G
      data[dst + x * 3 + 2] = bgra[src + x * 4 + 2]; // R
    }
  }
  const head = Buffer.alloc(54);
  head.write('BM', 0);
  head.writeUInt32LE(54 + data.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(width, 18);
  head.writeInt32LE(height, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(data.length, 34);
  head.writeInt32LE(2835, 38); // 72 dpi
  head.writeInt32LE(2835, 42);
  return Buffer.concat([head, data]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  for (const art of ART) {
    const image = await render(art);
    fs.writeFileSync(path.join(BUILD, art.file), bmp(image));
    // A PNG copy to look at (not used by the build).
    if (process.argv.includes('--preview')) fs.writeFileSync(path.join(BUILD, art.file.replace('.bmp', '.preview.png')), image.toPNG());
    console.log(`Wrote build/${art.file}`);
  }
  app.quit();
});
