# ☕ Coffee

**A fast, minimal browser for Windows.** Clean design, built-in ad blocking, and nothing in your way.

**[⬇ Download the latest version](https://github.com/umamidayo/coffee/releases/latest)**: run `Coffee-Setup-x.y.z.exe`. No admin rights needed, and Coffee keeps itself up to date.

The first time you open Coffee, a quick setup helps you pick a theme, where your tabs go, and your search engine. You can run it again any time from Settings.

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

**Private browsing**
- Press `Ctrl+Shift+N` for a private tab. It has a mask badge and a violet address bar.
- Private tabs don't save history, and their cookies and site data are deleted when you close the last one.

**Switching from Chrome?**
- Bring your bookmarks (with folders and icons) and your history over in one click. This works with Chrome, Edge, Brave and Vivaldi.
- New users are offered this during setup, or go to **Settings → Import** at any time. Your old browser isn't changed.
- Saved passwords and cookies can't be imported. Chrome locks them so only Chrome can read them.

**Extensions (optional)**
- Off by default, so Coffee stays lean if you don't use them.
- Turn on **Allow extensions** in Settings to install extensions from the Chrome Web Store with its "Add to Coffee" button.
- Extension buttons appear in the toolbar. The puzzle button lets you manage or remove them.
- Most extensions work, but not every Chrome feature is available yet. Extensions don't run in private tabs.

**Pop-out video**
- Watch a video in a small floating window that stays on top while you work in other tabs, windows or apps.
- Press `Alt+P`, click the pop-out button that appears in the address bar while something plays, or right-click the video.
- It keeps playing when you go back, click a link or search on the site (YouTube included), or close the tab or window. It stops when you close the floating video.
- **Back to tab** in the floating video puts it back in the tab it came from, still playing. If you closed that tab, it opens in a new one.

**Multiple windows and split view**
- Multiple windows are on by default; split view is off until you turn on **Split view** in **Settings → Tabs** (where you can also turn multiple windows off).
- `Ctrl+N` opens a new window.
- Drag a tab out of the tab strip and a card of it follows your pointer, with a preview of the page and what will happen when you let go:
  - **Left or right half of the page:** that half lights up, and the tab opens there, side by side with the tab you were on.
  - **Another Coffee window:** that window lights up, and a space opens in its tab strip where the tab will land.
  - **Anywhere else:** an outline shows where the new window will open.
- The page keeps running while it moves, so videos and forms aren't interrupted. Press `Esc` to cancel a drag.
- You can also right-click a tab and choose **Open beside current tab**. In split view, click either side to use it, and drag the divider to resize it.

**New tab page**
- A clock and the date, plus shortcuts to your favorite sites.
- Hover a shortcut and click × to remove it.
- Turn shortcuts off to see just the time and date.

**Also**
- Themes: Coffee, Latte, Dark, Light, Midnight, Matcha, Rosé, OLED, or make your own from four colors.
- Downloads panel with progress, pause and resume, and *Show in folder*.
- Find in page, zoom, and full screen.

Everything above lives in **Settings** (the ⚙ in the sidebar, the ⋮ menu, or `Ctrl+,`). Settings are grouped by category, and you can search them.

## Keyboard shortcuts

| Action | Keys |
|---|---|
| New tab / close tab | `Ctrl+T` / `Ctrl+W` |
| New private tab | `Ctrl+Shift+N` |
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
