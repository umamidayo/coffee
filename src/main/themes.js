'use strict';
// Theme presets. Each theme has four base colors; every other UI color is
// derived from these in CSS (color-mix), so custom themes always look coherent.

const PRESETS = [
  { id: 'coffee',   name: 'Coffee',   mode: 'dark',  bg: '#17120e', surface: '#211a15', text: '#efe4d8', accent: '#c89b6d' },
  { id: 'latte',    name: 'Latte',    mode: 'light', bg: '#ede3d7', surface: '#faf6f1', text: '#3b2d22', accent: '#a5683a' },
  { id: 'dark',     name: 'Dark',     mode: 'dark',  bg: '#111111', surface: '#1b1b1c', text: '#ececec', accent: '#8ab4f8' },
  { id: 'light',    name: 'Light',    mode: 'light', bg: '#f1f1f2', surface: '#ffffff', text: '#1f1f22', accent: '#3b6fe0' },
  { id: 'midnight', name: 'Midnight', mode: 'dark',  bg: '#0d1120', surface: '#151a2d', text: '#e2e6f5', accent: '#8090ff' },
  { id: 'matcha',   name: 'Matcha',   mode: 'dark',  bg: '#111611', surface: '#192019', text: '#e1eadb', accent: '#9cc77f' },
  { id: 'rose',     name: 'Rosé',     mode: 'light', bg: '#f4e9e8', surface: '#fffafa', text: '#3a2628', accent: '#c4677a' },
  { id: 'oled',     name: 'OLED',     mode: 'dark',  bg: '#000000', surface: '#0d0d0d', text: '#e8e8e8', accent: '#f2f2f2' },
  { id: 'nord',     name: 'Nord',     mode: 'dark',  bg: '#2e3440', surface: '#3b4252', text: '#eceff4', accent: '#88c0d0' },
  { id: 'sepia',    name: 'Sepia',    mode: 'light', bg: '#f4ecd8', surface: '#fbf5e6', text: '#5b4636', accent: '#b07d3c' },
  { id: 'forest',   name: 'Forest',   mode: 'dark',  bg: '#0f1f17', surface: '#16291f', text: '#dcebe0', accent: '#6fbf8f' },
  { id: 'ocean',    name: 'Ocean',    mode: 'light', bg: '#e6f1f5', surface: '#f8fcfd', text: '#1c3a46', accent: '#1f8aa8' },
];

const HEX = /^#[0-9a-f]{6}$/i;
const MAX_SAVED = 24;

/** Keep only well-formed saved themes: { id, name, bg, surface, text, accent }. */
function sanitizeSaved(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const id = String(t.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
    if (!id || seen.has(id)) continue;
    const colors = sanitizeCustom(t);
    const name = String(t.name || '').replace(/\s+/g, ' ').trim().slice(0, 32) || 'My theme';
    seen.add(id);
    out.push({ id, name, bg: colors.bg, surface: colors.surface, text: colors.text, accent: colors.accent });
    if (out.length >= MAX_SAVED) break;
  }
  return out;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function sanitizeCustom(c = {}) {
  const base = PRESETS[0];
  const pick = (k) => (typeof c[k] === 'string' && HEX.test(c[k]) ? c[k].toLowerCase() : base[k]);
  const out = { bg: pick('bg'), surface: pick('surface'), text: pick('text'), accent: pick('accent') };
  out.mode = luminance(out.bg) < 0.35 ? 'dark' : 'light';
  return out;
}

/** Resolve the settings' theme value to concrete colors. */
function resolve(setting) {
  const s = setting || {};
  let t;
  const saved = Array.isArray(s.saved) ? sanitizeSaved(s.saved) : [];
  if (s.preset === 'custom') t = { id: 'custom', name: 'Custom', ...sanitizeCustom(s.custom) };
  else if (typeof s.preset === 'string' && s.preset.startsWith('saved:') && saved.some((x) => `saved:${x.id}` === s.preset)) {
    const x = saved.find((y) => `saved:${y.id}` === s.preset);
    t = { id: s.preset, name: x.name, ...sanitizeCustom(x) };
  } else t = PRESETS.find((p) => p.id === s.preset) || PRESETS[0];
  return {
    id: t.id,
    mode: t.mode,
    vars: {
      '--bg': t.bg,
      '--surface': t.surface,
      '--text': t.text,
      '--accent': t.accent,
      '--on-accent': luminance(t.accent) > 0.4 ? '#141414' : '#ffffff',
    },
  };
}

module.exports = { PRESETS, resolve, sanitizeCustom, sanitizeSaved, MAX_SAVED };
