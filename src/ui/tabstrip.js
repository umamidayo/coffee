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
    if (t.internal) return `<span class="glyph">${/^coffee:\/\/history/.test(t.url) ? Icons.history : Icons.settings}</span>`;
    if (t.favicon) return `<img src="${encodeURI(t.favicon)}" alt="" draggable="false">`;
    if (t.url) return `<span class="letter">${letterFor(t)}</span>`;
    return `<span class="glyph">${Icons.globe}</span>`;
  }

  class TabStrip {
    /**
     * @param {HTMLElement} root  element that holds the tabs
     * @param {object} opts
     *   api          window.coffee
     *   orientation  'vertical' | 'horizontal'
     *   titles       show titles next to icons
     *   activateOn   'pointerdown' (instant) | 'click' (lets you drag first)
     *   onHover(node), onLeave()   optional tooltip hooks
     */
    constructor(root, opts) {
      this.root = root;
      this.api = opts.api;
      this.vertical = opts.orientation !== 'horizontal';
      this.activateOn = opts.activateOn || 'pointerdown';
      this.onHover = opts.onHover || (() => {});
      this.onLeave = opts.onLeave || (() => {});
      this.nodes = new Map();
      this.tabs = [];
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
      window.addEventListener('pointermove', this.onMove);
      window.addEventListener('pointerup', this.onUp);
    }

    destroy() {
      window.removeEventListener('pointermove', this.onMove);
      window.removeEventListener('pointerup', this.onUp);
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
        + `<span class="tab-title"></span><button class="tab-close" tabindex="-1" aria-label="Close tab">${Icons.close}</button>`;
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
      n.classList.toggle('loading', t.loading && !t.newtab);
      n.classList.toggle('sleeping', t.sleeping && t.id !== this.activeId);
      n.classList.toggle('audible', t.audible && !t.muted);
      n.classList.toggle('muted', t.muted);
      n.classList.toggle('private', !!t.private);
      if (t.audible || t.muted) n._audio.innerHTML = t.muted ? Icons.mute : Icons.volume;
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
      this.tabs = snap.tabs;
      this.activeId = snap.activeId;
      if (this.drag && this.drag.active) { this.pendingRender = true; return; }
      const ids = new Set(this.tabs.map((t) => t.id));
      this.flip(() => {
        for (const [id, n] of this.nodes) {
          if (ids.has(id)) continue;
          this.nodes.delete(id);
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
        if (e.target.closest('.tab-close') || e.button !== 0) return;
        if (this.activateOn === 'pointerdown') this.activate(id());
        this.drag = { node: n, id: id(), startPos: this.client(e), grab: this.client(e) - this.start(n), active: false, pointer: e.pointerId };
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
        this.onLeave();
        this.api.send('tab:menu', { id: id(), x: e.clientX, y: e.clientY });
      });
      n.addEventListener('mouseenter', () => this.onHover(n));
      n.addEventListener('mouseleave', () => this.onLeave());
    }

    dragMove(e) {
      const d = this.drag;
      if (!d) return;
      if (!d.active) {
        if (Math.abs(this.client(e) - d.startPos) < 5) return;
        d.active = true;
        d.node._dragged = true;
        this.onLeave();
        d.node.classList.add('dragging');
        this.root.classList.add('drag-active');
        try { d.node.setPointerCapture(d.pointer); } catch { /* ignore */ }
      }
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

    dragEnd() {
      const d = this.drag;
      this.drag = null;
      if (!d || !d.active) return;
      const index = this.live().indexOf(d.node);
      d.node.style.transition = 'transform .28s var(--spring)';
      d.node.style.transform = '';
      d.node.classList.remove('dragging');
      this.root.classList.remove('drag-active');
      setTimeout(() => { d.node.style.transition = ''; }, 300);
      // Reflect locally right away; main confirms with a fresh snapshot.
      const t = this.tabs.find((x) => x.id === d.id);
      this.tabs = this.tabs.filter((x) => x.id !== d.id);
      this.tabs.splice(index, 0, t);
      this.api.send('tab:move', { id: d.id, index });
      if (this.pendingRender) { this.pendingRender = false; this.render({ tabs: this.tabs, activeId: this.activeId }); }
      this.moveHighlight();
    }

    get dragging() { return !!(this.drag && this.drag.active); }
  }

  window.TabStrip = TabStrip;
})();
