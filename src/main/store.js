'use strict';
// Tiny JSON persistence with debounced, atomic writes.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const all = new Set();

class Store {
  constructor(name, defaults, delay = 500) {
    this.file = path.join(app.getPath('userData'), `${name}.json`);
    this.delay = delay;
    this.timer = null;
    let loaded = null;
    try {
      loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* first run or corrupt file */
    }
    this.data = Array.isArray(defaults)
      ? (Array.isArray(loaded) ? loaded : structuredClone(defaults))
      : { ...structuredClone(defaults), ...(loaded && typeof loaded === 'object' ? loaded : {}) };
    all.add(this);
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Failed to save', this.file, err);
    }
  }

  static flushAll() {
    for (const s of all) if (s.timer) s.flush();
  }
}

module.exports = Store;
