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
];

const HEX = /^#[0-9a-f]{6}$/i;

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
  if (s.preset === 'custom') t = { id: 'custom', name: 'Custom', ...sanitizeCustom(s.custom) };
  else t = PRESETS.find((p) => p.id === s.preset) || PRESETS[0];
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

module.exports = { PRESETS, resolve, sanitizeCustom };
