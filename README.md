# ☕ Coffee

**A fast, minimal browser for Windows.** Clean design, built-in ad blocking, and nothing in your way.

**[⬇ Download the latest version](https://github.com/umamidayo/coffee/releases/latest)**: run `Coffee-Setup-x.y.z.exe`. No admin rights needed, and Coffee keeps itself up to date.

---

## Why Coffee

- **Fast.** Chrome's engine, with a lightweight interface on top. Tabs you haven't used in a while go to sleep, so they don't slow you down.
- **No ads.** Ads and trackers are blocked out of the box, including on YouTube.
- **Out of your way.** No window frame, no clutter. The page gets almost the whole screen.
- **Yours.** Pick a theme, put tabs where you like them, hide what you don't need.

## Features

**Tabs**
- Tabs on the **side** as icons, or on **top** with titles. You can also make top tabs icons only.
- **Compact sidebar.** Side tabs stay hidden until you move the mouse to the left edge of the window.
- Drag tabs to reorder them, and middle-click to close.
- Right-click empty tab space to reopen recently closed tabs.

**Bookmarks**
- Press the ☆ in the address bar (or `Ctrl+D`) to bookmark a page.
- Organize bookmarks into **folders**. Folders can hold other folders.
  - Right-click the bookmarks bar to create a folder.
  - Drag a bookmark onto a folder to move it in.
  - Or choose a folder in the bookmark's edit box.

**Address bar**
- Start typing and it fills in sites you visit (`goo` → `google.com`). Press Enter to go there.
- Suggestions come from your history and bookmarks.

**New tab page**
- A clock and the date, plus shortcuts to your favorite sites.
- Hover a shortcut and click × to remove it.
- Turn shortcuts off to see just the time and date.

**Also**
- Themes: Coffee, Latte, Dark, Light, Midnight, Matcha, Rosé, OLED, or make your own from four colors.
- Downloads panel with progress, pause and resume, and *Show in folder*.
- Find in page, zoom, and full screen.

Everything above lives in **Settings** (the ⚙ in the sidebar, the ⋮ menu, or `Ctrl+,`).

## Keyboard shortcuts

| Action | Keys |
|---|---|
| New tab / close tab | `Ctrl+T` / `Ctrl+W` |
| Reopen closed tab | `Ctrl+Shift+T` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Go to tab 1–8 / last tab | `Ctrl+1`–`8` / `Ctrl+9` |
| Address bar | `Ctrl+L` or `F6` |
| Back / forward | `Alt+←` / `Alt+→` (or mouse side buttons) |
| Reload | `Ctrl+R` or `F5` |
| Find in page | `Ctrl+F` |
| Bookmark page | `Ctrl+D` |
| Show/hide bookmarks bar | `Ctrl+Shift+B` |
| Downloads | `Ctrl+J` |
| Zoom in / out / reset | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Full screen | `F11` |
| Settings | `Ctrl+,` |

## Privacy

Coffee blocks ads and trackers using the same filter lists as uBlock Origin, kept up to date automatically. You can clear your history, cookies and site data any time in Settings. Coffee has no accounts and no telemetry.

---

## For developers

```sh
npm install
npm start           # run from source
npm run dist        # build the installer into dist/
npm run release     # publish a new version (bump "version" in package.json, commit, push, set GH_TOKEN)
```

Coffee is free software under the [GNU GPL v3](LICENSE). It includes uBlock Origin's scriptlets; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
