# Coffee

A fast, minimal browser for Windows. Chromium engine, frameless window, vertical icon tabs, built-in ad blocking, and themes.

## Run

```sh
npm install
npm start          # run from source
npm run dist       # build the Windows installer: dist/Coffee-Setup-<version>.exe
npm run release    # build + publish a GitHub release (installed copies auto-update)
npm run icon       # re-render build/icon.png + icon.ico from build/icon.svg
```

## Releasing updates

Installed copies check GitHub Releases on startup and every 4 hours. They download new versions in the background and show a **Restart to update** button. Anything left pending installs the next time Coffee quits.

1. One-time setup: releases publish to **github.com/umamidayo/coffee-browser** (`build.publish` in `package.json`). Create that repository as **public**, then create a GitHub token that can write releases (classic: `repo` scope; fine-grained: Contents read/write on that repo) and expose it as `GH_TOKEN`.
2. For each update, bump `version` in `package.json` (e.g. `0.1.0` → `0.1.1`), then run `npm run release`.

The repository must be public so installed copies can read the releases without a token. The installer is unsigned, so Windows SmartScreen shows a warning on first install. Updates install silently.

The installer is per-user (no admin needed) and registers Coffee as a browser, so you can pick it in **Settings → Apps → Default apps**.

## Features

- **Frameless window.** A custom title bar holds navigation, the address bar and window controls in one 46px row, so nearly the whole screen is the page.
- **Vertical icon tabs.** Drag to reorder, middle-click to close, right-click a tab for its menu, right-click empty space to reopen recently closed tabs, hover for the title. Tabs show a loading ring and an audio badge (click the badge to mute).
- **Ad and tracker blocking, the uBlock Origin way.** Coffee uses uBO's own default filter lists (uBlock filters, quick fixes, badware, privacy, unbreak, resource abuse, EasyList, EasyPrivacy, Peter Lowe), fetched from uBO's servers with its `!#include`/`!#if` directives resolved. It also uses uBO's own scriptlet library, converted from uBO's source at its latest stable release by `npm run scriptlets` (this runs automatically before `dist`/`release`, and the converter only parses uBO's code, never runs it). Scriptlets are injected synchronously into the page's main world at document start in every frame, before any page script, the same way uBO does it. Scriptlet timing and version are what defeat YouTube's ads and its anti-adblock slowdown. Lists refresh every 6 hours in the background. The shield in the address bar shows a per-page count.
- **Downloads** go straight to your downloads folder. The panel has progress, speed, pause/resume and show in folder.
- **Bookmarks.** Use the star or Ctrl+D, then rename inline. Bookmarks appear in the bookmarks bar and on the new tab page.
- **Themes.** Presets are Coffee, Latte, Dark, Light, Midnight, Matcha, Rosé and OLED, plus a custom theme built from four colors (background, surface, text, accent). Every other shade is derived from those four.
- **Google sign-in works.** Google rejects embedded Chromium browsers ("This browser or app may not be secure"). On `accounts.google.com` only, Coffee presents itself consistently as Firefox, in both request headers and `navigator.*`; see `src/main/compat.js`. Every other site, including the rest of Google, sees normal Chrome.
- Address bar suggestions from history and bookmarks, find in page, per-tab zoom, permission prompts, friendly error pages, and session restore.

## Performance

- The UI is plain HTML/CSS/JS with no framework. Animations use only `transform` and `opacity`.
- **Lazy tabs.** Restored and background tabs create no renderer until you open them.
- **Tab sleeping.** Inactive tabs release their renderer after 30 minutes by default (configurable). Back/forward history is kept.
- All popups (menus, suggestions, downloads, tooltips, prompts) share one overlay process.
- Tab state changes are batched into one IPC message per frame. Session snapshots are debounced.

## Shortcuts

| Keys | Action |
|---|---|
| Ctrl+T / Ctrl+W / Ctrl+Shift+T | New / close / reopen tab |
| Ctrl+Tab, Ctrl+1–9 | Switch tabs |
| Ctrl+L, Alt+D, F6 | Focus address bar |
| Alt+← / Alt+→, mouse side buttons | Back / forward |
| Ctrl+R, F5 (Ctrl+Shift+R hard) | Reload |
| Ctrl+F, Ctrl+G | Find in page |
| Ctrl+D, Ctrl+Shift+B | Bookmark page, toggle bookmarks bar |
| Ctrl+J | Downloads |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom |
| F11 | Full screen (window controls hide; tabs and address bar stay) |
| F12, Ctrl+Shift+I | DevTools |
| Ctrl+, | Settings and themes |

## Layout

```
src/main/      main process: window, layout, tabs, overlay, ad-block, compat, downloads, data, themes, updater
src/preload/   ui.js (browser chrome + overlay), internal.js (coffee:// pages only), adblock.js + compat.js (every web frame)
src/ui/        browser chrome (index.html) and popup layer (overlay.html)
src/pages/     coffee://newtab, coffee://settings, coffee://error, shared theme tokens
build/         app icon + installer.nsh (default-browser registration)
```

Layout metrics (sidebar 56px, top bar 46px, bookmarks bar 32px; the page runs to the right and bottom window edges) are defined in both `src/main/main.js` and `src/ui/ui.css`. Change them together.
