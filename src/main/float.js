'use strict';
// A second transparent view for passing hints that must not take over the
// overlay: the link status bubble and tab hover cards. They can show while a
// popup (or the compact peek panel) is open, and never take focus.
//
// Main says what to show and where it is anchored; the page renders it,
// measures it and reports its size, and only then is it placed and shown,
// so it never covers more of the page than it needs (a view takes the mouse
// over all of its bounds, transparent or not).
const path = require('path');
const { WebContentsView } = require('electron');

class Float {
  constructor(win, preload) {
    this.win = win;
    this.view = new WebContentsView({
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    this.view.setBackgroundColor('#00000000');
    this.view.setVisible(false);
    this.view.webContents.loadFile(path.join(__dirname, '..', 'ui', 'float.html'));
    this.seq = 0;
    this.current = null; // { kind, place, seq, shown }
    this.hideTimer = null;
    win.contentView.addChildView(this.view);
  }

  get wc() {
    return this.view.webContents;
  }

  isShowing(kind) {
    return !!this.current && (!kind || this.current.kind === kind);
  }

  /**
   * @param {string} kind   'status' | 'tabcard'
   * @param {object} data   rendered by float.html
   * @param {(size:{width,height}) => {x,y}} place  window-relative top-left for a measured size
   */
  show(kind, data, place) {
    clearTimeout(this.hideTimer);
    if (this.view.webContents.isDestroyed()) return;
    const seq = ++this.seq;
    const shown = !!this.current && this.current.kind === kind && this.current.shown;
    this.current = { kind, place, seq, shown };
    this.wc.send('ev:float:show', { kind, data, seq, update: shown });
  }

  /** The page measured what it drew. */
  sized(seq, width, height) {
    const cur = this.current;
    if (!cur || cur.seq !== seq || this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize();
    width = Math.ceil(Math.min(width, w));
    height = Math.ceil(Math.min(height, h));
    const p = cur.place({ width, height });
    this.view.setBounds({
      x: Math.round(Math.max(0, Math.min(p.x, w - width))),
      y: Math.round(Math.max(0, Math.min(p.y, h - height))),
      width,
      height,
    });
    if (!cur.shown) {
      // Re-adding puts it on top of the pages (and of an open popup).
      this.win.contentView.addChildView(this.view);
      this.view.setVisible(true);
      cur.shown = true;
    }
  }

  /** Hide (after `delay` ms, so moving from one link to the next doesn't flicker). */
  hide(kind, delay = 0) {
    if (!this.isShowing(kind)) return;
    clearTimeout(this.hideTimer);
    const go = () => {
      if (!this.isShowing(kind)) return;
      this.current = null;
      this.seq++;
      if (this.win.isDestroyed()) return;
      this.view.setVisible(false);
      if (!this.wc.isDestroyed()) this.wc.send('ev:float:hide');
    };
    if (delay > 0) this.hideTimer = setTimeout(go, delay);
    else go();
  }

  destroy() {
    clearTimeout(this.hideTimer);
    try { if (!this.wc.isDestroyed()) this.wc.close(); } catch { /* already gone */ }
  }
}

module.exports = Float;
