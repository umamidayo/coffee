'use strict';
/* global Icons */
// A tab strip: keyed DOM updates, sliding active highlight, FLIP animations,
// drag to reorder, middle-click close, context menu. Used for the side bar
// (icons only), the top strip (icons + titles) and the compact peek panel.
(() => {
  const SPINNER = '<svg class="spinner" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14"/></svg>';

  function letterFor(t) {
    try { return new URL(t.url).hostname.replace(/^www\./, '').charAt(0).toUpperCase() || '•'; } catch { return (t.title || '•').charAt(0).toUpperCase(); }
  }

  function iconMarkup(t) {
    if (t.newtab) return `<span class="glyph">${Icons.sparkle}</span>`;
    if (t.internal) {
      const icon = /^coffee:\/\/history/.test(t.url) ? Icons.history : /^coffee:\/\/whats-new/.test(t.url) ? Icons.sparkle : Icons.settings;
      return `<span class="glyph">${icon}</span>`;
    }
    if (t.favicon) return `<img src="${encodeURI(t.favicon)}" alt="" draggable="false">`;
    if (t.url) return `<span class="letter">${letterFor(t)}</span>`;
    return `<span class="glyph">${Icons.globe}</span>`;
  }

  // Hover cards: the first waits a moment; moving on to the next tab within a
  // short while shows it straight away (shared by every strip on this page).
  const CARD_DELAY = 450;
  const CARD_WARM = 700;
  let cardWarm = 0;

  class TabStrip {
    /**
     * @param {HTMLElement} root  element that holds the tabs
     * @param {object} opts
     *   api          window.coffee
     *   orientation  'vertical' | 'horizontal'
     *   titles       show titles next to icons
     *   activateOn   'pointerdown' (instant) | 'click' (lets you drag first)
     *   onHover(node), onLeave()   optional tooltip hooks
     *   canTear      tabs dragged away from the strip go to split view, another window or a new one (default on)
     *   hoverCards   show a card (title, address, preview) when the pointer rests on a tab (default on)
     */
    constructor(root, opts) {
      this.root = root;
      this.api = opts.api;
      this.vertical = opts.orientation !== 'horizontal';
      this.activateOn = opts.activateOn || 'pointerdown';
      this.onHover = opts.onHover || (() => {});
      this.onLeave = opts.onLeave || (() => {});
      this.canTear = opts.canTear !== false;
      this.hoverCards = opts.hoverCards !== false;
      this.cardTimer = null;
      this.cardId = null; // the tab whose card is showing
      this.nodes = new Map();
      this.tabs = [];
      this.snap = { tabs: [], activeId: null };
      this.activeId = null;
      this.drag = null;
      this.pendingRender = false;
      root.classList.add('ts', this.vertical ? 'ts-v' : 'ts-h');
      root.classList.toggle('ts-titles', !!opts.titles);
      this.highlight = document.createElement('div');
      this.highlight.className = 'ts-highlight';
      root.prepend(this.highlight);
      this.onMove = (e) => this.dragMove(e);
      this.onUp = () => this.dragEnd();
      // The system took the pointer away mid-drag: put the tab back.
      this.onCancel = () => {
        const d = this.drag;
        if (d && d.active && this.canTear) this.api.send('tab:drag', { id: d.id, phase: 'cancel' });
        this.abortDrag();
      };
      window.addEventListener('pointermove', this.onMove);
      window.addEventListener('pointerup', this.onUp);
      window.addEventListener('pointercancel', this.onCancel);
      // Main runs a drag once the tab leaves the strip (see main.js).
      this.offs = [
        this.api.on('drag:tear', (m) => this.tear(m.id, m.out)),
        // Main finished the drop (it may see the release before we do, or instead of us).
        this.api.on('drag:done', (m) => { if (this.drag && this.drag.id === m.id) this.abortDrag(); }),
        this.api.on('drag:abort', () => this.abortDrag()),
      ];
    }

    destroy() {
      this.hideCard();
      window.removeEventListener('pointermove', this.onMove);
      window.removeEventListener('pointerup', this.onUp);
      window.removeEventListener('pointercancel', this.onCancel);
      for (const off of this.offs) off();
    }

    // ---- a tab dragged here from another window -----------------------------
    /** Show a placeholder for it (it lands where the placeholder is). */
    showIncoming(t) {
      this.hideIncoming(true);
      const n = document.createElement('div');
      n.className = 'tab incoming';
      n.innerHTML = `<div class="tab-ico"><div class="tab-icon">${iconMarkup({ favicon: t.favicon, title: t.title, url: '' })}</div></div><span class="tab-title"></span>`;
      n.querySelector('.tab-title').textContent = t.title || 'New Tab';
      const img = n.querySelector('img');
      if (img) img.onerror = () => { img.outerHTML = `<span class="glyph">${Icons.globe}</span>`; };
      this.incomingNode = n;
      this.incomingIndex = null;
      return n;
    }

    hideIncoming(instant) {
      const n = this.incomingNode;
      if (!n) return;
      this.incomingNode = null;
      if (instant || !n.isConnected) { n.remove(); return; }
      this.flip(() => n.remove());
      this.moveHighlight();
    }

    /** The pointer is at (x, y) on this page: move the placeholder there; returns the tab index it stands for. */
    incomingAt(x, y) {
      const n = this.incomingNode;
      if (!n) return null;
      const others = this.live().filter((o) => o !== n);
      // Over (or near) the strip: between the tabs under the pointer. Elsewhere on the window: at the end.
      const area = (this.root.closest('#tabs-scroll, #htabs-scroll, .peek-scroll') || this.root).getBoundingClientRect();
      let to = others.length;
      if (x >= area.left - 40 && x <= area.right + 40 && y >= area.top - 40 && y <= area.bottom + 40) {
        const c = (this.vertical ? y : x) - this.start(this.root);
        to = others.filter((o) => this.pos(o) + this.size(o) / 2 < c).length;
      }
      if (to !== this.incomingIndex || !n.isConnected) {
        this.incomingIndex = to;
        this.flip(() => {
          if (to < others.length) others[to].before(n);
          else (others[others.length - 1] || this.highlight).after(n);
        });
        this.moveHighlight();
      }
      return to;
    }

    // ---- axis helpers -------------------------------------------------------
    pos(n) { return this.vertical ? n.offsetTop : n.offsetLeft; }
    size(n) { return this.vertical ? n.offsetHeight : n.offsetWidth; }
    client(e) { return this.vertical ? e.clientY : e.clientX; }
    start(n) { const r = n.getBoundingClientRect(); return this.vertical ? r.top : r.left; }
    translate(px) { return this.vertical ? `translateY(${px}px)` : `translateX(${px}px)`; }
    live() { return [...this.root.querySelectorAll('.tab:not(.leaving)')]; }

    // ---- rendering ----------------------------------------------------------
    createNode(t) {
      const n = document.createElement('div');
      n.className = 'tab entering';
      n.dataset.id = t.id;
      n.innerHTML = `<div class="tab-ico"><div class="tab-icon"></div>${SPINNER}<span class="audio"></span><span class="priv">${Icons.mask}</span></div>`
        + `<span class="tab-title"></span><button class="tab-close" tabindex="-1" aria-label="Close tab" title="Close tab (Ctrl+W)">${Icons.close}</button>`;
      n.addEventListener('animationend', () => n.classList.remove('entering'), { once: true });
      n._icon = n.querySelector('.tab-icon');
      n._audio = n.querySelector('.audio');
      n._titleEl = n.querySelector('.tab-title');
      n._iconKey = '';
      this.bind(n);
      return n;
    }

    updateNode(n, t) {
      const key = t.newtab ? 'new' : t.internal ? 'int' : t.favicon || `l:${t.url}`;
      if (key !== n._iconKey) {
        n._iconKey = key;
        n._icon.innerHTML = iconMarkup(t);
        const img = n._icon.querySelector('img');
        if (img) img.onerror = () => { n._icon.innerHTML = `<span class="letter">${letterFor(t)}</span>`; };
      }
      n.classList.toggle('active', t.id === this.activeId);
      // The other half of a split view (on screen or not) gets an outline.
      n.classList.toggle('paired', !!this.pair && this.pair.includes(t.id) && t.id !== this.activeId);
      n.classList.toggle('pane', t.id === this.paneId);
      n.classList.toggle('loading', t.loading && !t.newtab);
      n.classList.toggle('sleeping', t.sleeping && t.id !== this.activeId);
      n.classList.toggle('audible', t.audible && !t.muted);
      n.classList.toggle('muted', t.muted);
      n.classList.toggle('private', !!t.private);
      if (t.audible || t.muted) {
        n._audio.innerHTML = t.muted ? Icons.mute : Icons.volume;
        n._audio.title = t.muted ? 'Unmute tab' : 'Mute tab';
      }
      const title = t.title || 'New Tab';
      if (n._title !== title) { n._title = title; n._titleEl.textContent = title; }
    }

    /** FLIP: animate siblings from their old position to the new one. */
    flip(mutate, skip) {
      const before = new Map();
      for (const n of this.live()) if (n !== skip) before.set(n, this.pos(n));
      mutate();
      for (const [n, p] of before) {
        if (!n.isConnected || n.classList.contains('leaving')) continue;
        const d = p - this.pos(n);
        if (!d) continue;
        n.style.transition = 'none';
        n.style.transform = this.translate(d);
        requestAnimationFrame(() => {
          n.style.transition = 'transform .3s var(--spring), background .15s';
          n.style.transform = '';
        });
      }
    }

    render(snap) {
      this.snap = snap;
      this.tabs = snap.tabs;
      this.activeId = snap.activeId;
      this.paneId = snap.paneId || null;
      this.pair = snap.pair || null;
      if (this.drag && this.drag.active) { this.pendingRender = true; return; }
      const ids = new Set(this.tabs.map((t) => t.id));
      this.flip(() => {
        for (const [id, n] of this.nodes) {
          if (ids.has(id)) continue;
          this.nodes.delete(id);
          if (this.cardId === id) this.hideCard();
          // Leave the flow immediately so neighbours slide into place.
          n.style.width = `${n.offsetWidth}px`;
          n.style.height = `${n.offsetHeight}px`;
          n.style.left = `${n.offsetLeft}px`;
          n.style.top = `${n.offsetTop}px`;
          n.classList.add('leaving');
          setTimeout(() => n.remove(), 220);
        }
        let prev = this.highlight;
        for (const t of this.tabs) {
          let n = this.nodes.get(t.id);
          if (!n) { n = this.createNode(t); this.nodes.set(t.id, n); }
          this.updateNode(n, t);
          if (prev.nextSibling !== n) prev.after(n);
          prev = n;
        }
        for (const n of this.root.querySelectorAll('.tab.leaving')) this.root.appendChild(n);
      });
      this.moveHighlight();
    }

    moveHighlight() {
      const h = this.highlight;
      const n = this.nodes.get(this.activeId);
      if (!n) { h.classList.remove('on'); return; }
      const apply = () => {
        h.style.width = `${n.offsetWidth}px`;
        h.style.height = `${n.offsetHeight}px`;
        h.style.transform = `translate(${n.offsetLeft}px, ${n.offsetTop}px)`;
      };
      if (!h.classList.contains('on')) {
        h.style.transition = 'none';
        apply();
        void h.offsetTop;
        h.style.transition = '';
        h.classList.add('on');
      } else {
        apply();
      }
      if (!this.drag || !this.drag.active) n.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    /** Re-measure (e.g. after the strip was resized or shown). */
    relayout() { this.moveHighlight(); }

    /** Switch between titled tabs and icon-only tabs. */
    setTitles(on) {
      if (this.root.classList.contains('ts-titles') === !!on) return;
      this.root.classList.toggle('ts-titles', !!on);
      requestAnimationFrame(() => this.moveHighlight());
    }

    // ---- hover cards ----------------------------------------------------------
    showCard(n) {
      if (!this.hoverCards) return;
      clearTimeout(this.cardTimer);
      const delay = Date.now() - cardWarm < CARD_WARM ? 0 : CARD_DELAY;
      this.cardTimer = setTimeout(() => {
        if (this.dragging || !n.isConnected || n.classList.contains('leaving') || !n.matches(':hover')) return;
        const r = n.getBoundingClientRect();
        this.cardId = Number(n.dataset.id);
        this.api.send('tabcard:show', {
          id: this.cardId,
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          side: this.vertical ? 'right' : 'below',
        });
        cardWarm = Date.now();
      }, delay);
    }

    hideCard() {
      clearTimeout(this.cardTimer);
      if (this.cardId === null) return;
      this.cardId = null;
      cardWarm = Date.now();
      this.api.send('tabcard:hide');
    }

    // ---- interactions -------------------------------------------------------
    activate(id) {
      if (id === this.activeId) return;
      this.activeId = id;
      for (const [tid, node] of this.nodes) node.classList.toggle('active', tid === id);
      this.moveHighlight();
      this.api.send('tab:activate', { id });
    }

    bind(n) {
      const id = () => Number(n.dataset.id);
      n.addEventListener('pointerdown', (e) => {
        this.hideCard();
        if (e.target.closest('.tab-close') || e.button !== 0) return;
        if (this.activateOn === 'pointerdown') this.activate(id());
        this.drag = { node: n, id: id(), x0: e.clientX, y0: e.clientY, grab: this.client(e) - this.start(n), active: false, pointer: e.pointerId };
      });
      if (this.activateOn === 'click') {
        n.addEventListener('click', (e) => {
          if (e.target.closest('.tab-close') || n._dragged) { n._dragged = false; return; }
          this.activate(id());
        });
      }
      n.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); this.api.send('tab:close', { id: id() }); } });
      n.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
      n.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); this.api.send('tab:close', { id: id() }); });
      n._audio.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.api.send('tab:mute', { id: id() }); });
      n.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.hideCard();
        this.onLeave();
        this.api.send('tab:menu', { id: id(), x: e.clientX, y: e.clientY });
      });
      n.addEventListener('mouseenter', () => { this.onHover(n); this.showCard(n); });
      n.addEventListener('mouseleave', () => { this.onLeave(); this.hideCard(); });
    }

    dragMove(e) {
      const d = this.drag;
      if (!d) return;
      if (!d.active) {
        // Either direction starts a drag: along the strip to reorder, across it to tear off.
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
        d.active = true;
        d.node._dragged = true;
        this.onLeave();
        this.hideCard();
        d.node.classList.add('dragging');
        this.root.classList.add('drag-active');
        try { d.node.setPointerCapture(d.pointer); } catch { /* ignore */ }
        // Main follows the pointer from here (it may leave this page): once it's
        // away from the strip, main shows a card of the tab that follows it and
        // what would happen on release, and tells us (drag:tear) to leave a
        // placeholder here.
        if (this.canTear) {
          const area = this.root.closest('#tabs-scroll, #htabs-scroll, .peek-scroll') || this.root;
          const r = area.getBoundingClientRect();
          this.api.send('tab:drag', { id: d.id, phase: 'begin', strip: { x: r.left, y: r.top, width: r.width, height: r.height } });
        }
      }
      if (d.out) return; // the card is what moves now
      const base = this.start(this.root);
      const live = this.live();
      const from = live.indexOf(d.node);
      // Target slot: how many other tabs have their centre before ours.
      const centre = this.client(e) - d.grab - base + this.size(d.node) / 2;
      const others = live.filter((x) => x !== d.node);
      const to = others.filter((x) => this.pos(x) + this.size(x) / 2 < centre).length;
      if (to !== from) {
        this.flip(() => {
          if (to >= others.length) others[others.length - 1].after(d.node);
          else others[to].before(d.node);
        }, d.node);
      }
      d.node.style.transform = this.translate(this.client(e) - d.grab - (base + this.pos(d.node)));
      this.moveHighlight();
    }

    /** Main says the dragged tab left the strip (or came back). */
    tear(id, out) {
      const d = this.drag;
      if (!d || !d.active || d.id !== id) return;
      d.out = out;
      d.node.classList.toggle('tearing', out);
      if (out) d.node.style.transform = '';
      this.moveHighlight();
    }

    dragEnd() {
      const d = this.drag;
      this.drag = null;
      if (!d || !d.active) return;
      const index = this.live().indexOf(d.node);
      d.node.style.transition = 'transform .28s var(--spring)';
      d.node.style.transform = '';
      d.node.classList.remove('dragging', 'tearing');
      this.root.classList.remove('drag-active');
      setTimeout(() => { d.node.style.transition = ''; }, 300);
      this.pendingRender = false;
      // Released: main decides (it knows where the pointer is). Away from the
      // strip it does what it showed (split, another window, a new window).
      if (this.canTear) this.api.send('tab:drag', { id: d.id, phase: 'end' });
      if (d.out) {
        this.render(this.snap);
        return;
      }
      // Reflect locally right away; main confirms with a fresh snapshot.
      const t = this.tabs.find((x) => x.id === d.id);
      const tabs = this.tabs.filter((x) => x.id !== d.id);
      tabs.splice(index, 0, t);
      this.api.send('tab:move', { id: d.id, index });
      this.render({ ...this.snap, tabs });
    }

    /** Stop a drag without dropping (Esc, or the pointer was taken away). */
    abortDrag() {
      const d = this.drag;
      this.drag = null;
      if (!d || !d.active) return;
      d.node.style.transition = 'transform .28s var(--spring)';
      d.node.style.transform = '';
      d.node.classList.remove('dragging', 'tearing');
      this.root.classList.remove('drag-active');
      setTimeout(() => { d.node.style.transition = ''; }, 300);
      this.pendingRender = false;
      this.render(this.snap);
    }

    get dragging() { return !!(this.drag && this.drag.active); }
  }

  window.TabStrip = TabStrip;
})();
