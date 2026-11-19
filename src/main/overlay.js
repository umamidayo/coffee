'use strict';
// A single transparent view stacked above the page. Every popup (menus,
// suggestions, downloads, tooltips, prompts) renders here, so the UI never
// gets hidden behind web content and we only pay for one extra renderer.
const path = require('path');
const { WebContentsView } = require('electron');

class Overlay {
  constructor(win, preload) {
    this.win = win;
    this.view = new WebContentsView({
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    this.view.setBackgroundColor('#00000000');
    this.view.setVisible(false);
    this.view.webContents.loadFile(path.join(__dirname, '..', 'ui', 'overlay.html'));
    this.current = null; // { type, handlers }
    win.contentView.addChildView(this.view);
  }

  get wc() {
    return this.view.webContents;
  }

  isOpen(type) {
    return !!this.current && (!type || this.current.type === type);
  }

  /**
   * @param {string} type   popup kind (menu, suggest, downloads, tooltip, ...)
   * @param {{x,y,width,height}} rect  window-relative bounds
   * @param {object} data   payload rendered by the overlay page
   * @param {object} opts   { focus, onPick, onClose, anchor }
   */
  open(type, rect, data, opts = {}) {
    if (this.current && this.current.type !== type) this.close(true);
    const [w, h] = this.win.getContentSize();
    const r = {
      x: Math.round(Math.max(0, Math.min(rect.x, w - rect.width))),
      y: Math.round(Math.max(0, Math.min(rect.y, h - rect.height))),
      width: Math.round(Math.min(rect.width, w)),
      height: Math.round(Math.min(rect.height, h)),
    };
    const reopen = this.current && this.current.type === type;
    this.current = { type, onPick: opts.onPick, onClose: opts.onClose };
    if (!reopen && this.onState) this.onState(type);
    this.view.setBounds(r);
    // Re-adding moves the view to the top of the stack (above the active tab).
    this.win.contentView.addChildView(this.view);
    this.view.setVisible(true);
    this.wc.send('ev:overlay:show', { type, data, reopen, flip: !!opts.flip });
    if (opts.focus) this.wc.focus();
  }

  update(type, data) {
    if (this.isOpen(type)) this.wc.send('ev:overlay:update', { type, data });
  }

  pick(payload) {
    const cur = this.current;
    if (!cur) return;
    const keepOpen = payload && payload.keepOpen;
    if (!keepOpen) {
      cur.onClose = null; // a pick is an answer, not a dismissal
      this.close(true);
    }
    if (cur.onPick) cur.onPick(payload);
  }

  close(silent = false) {
    if (!this.current) return;
    const cur = this.current;
    this.current = null;
    this.view.setVisible(false);
    this.wc.send('ev:overlay:hide');
    if (this.onState) this.onState(null);
    if (cur.onClose) cur.onClose(silent);
  }

  get type() {
    return this.current ? this.current.type : null;
  }
}

module.exports = Overlay;
