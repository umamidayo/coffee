'use strict';
// Theme presets. Each theme has four base colors; every other UI color is
// derived from these in CSS (color-mix), so custom themes always look coherent.
//
// Optional extras (presets and your own themes):
//   frame / frame2 / angle  the browser frame (toolbar, tab bar, side bar):
//                           one color (two-tone), or a gradient from frame to
//                           frame2 at `angle` degrees. Its text color is worked
//                           out to stay readable.
//   accent2                 a second accent: accent highlights become a gradient
//                           (loading bar, switches, buttons, split view).

// Each preset has its own character, so no two look alike: different base
// hues, and most use the frame (two-tone or gradient) and a second accent.
const PRESETS = [
  // Coffee's own look: espresso, caramel, a slightly deeper frame.
  { id: 'coffee',   name: 'Coffee',   mode: 'dark',  bg: '#17120e', surface: '#211a15', text: '#efe4d8', accent: '#c89b6d', accent2: '#e2b47c', frame: '#110d0a' },
  // Frothy cream with a milk-coffee frame.
  { id: 'latte',    name: 'Latte',    mode: 'light', bg: '#f1e8dd', surface: '#fbf7f2', text: '#3b2d22', accent: '#a5683a', accent2: '#c98b4f', frame: '#dcc8b2' },
  // Plain and neutral, on purpose.
  { id: 'dark',     name: 'Dark',     mode: 'dark',  bg: '#121212', surface: '#1c1c1d', text: '#ececec', accent: '#8ab4f8' },
  { id: 'light',    name: 'Light',    mode: 'light', bg: '#f2f2f3', surface: '#ffffff', text: '#1f1f22', accent: '#3b6fe0' },
  // Night sky: navy under an indigo-to-violet frame.
  { id: 'midnight', name: 'Midnight', mode: 'dark',  bg: '#0d1120', surface: '#151a2d', text: '#e2e6f5', accent: '#8090ff', accent2: '#b48cff', frame: '#0b1236', frame2: '#25124a', angle: 160 },
  // Matcha latte: a soft green page under a deep tea-green frame.
  { id: 'matcha',   name: 'Matcha',   mode: 'light', bg: '#e8eedb', surface: '#f7f9f1', text: '#273320', accent: '#5f8f32', accent2: '#8fb84a', frame: '#3c5a2a' },
  // Blush pink, fading to peach.
  { id: 'rose',     name: 'Rosé',     mode: 'light', bg: '#f6e8ea', surface: '#fffafb', text: '#3a2628', accent: '#c4577a', accent2: '#e8926b', frame: '#f0cdd6', frame2: '#f7dcc6', angle: 90 },
  // True black for OLED screens; nothing to light up but the text.
  { id: 'oled',     name: 'OLED',     mode: 'dark',  bg: '#000000', surface: '#0a0a0a', text: '#e8e8e8', accent: '#f2f2f2' },
  // Arctic blue-grey with two frost blues.
  { id: 'nord',     name: 'Nord',     mode: 'dark',  bg: '#2e3440', surface: '#3b4252', text: '#eceff4', accent: '#88c0d0', accent2: '#81a1c1', frame: '#262b35' },
  // Old paper, rust-red ink.
  { id: 'sepia',    name: 'Sepia',    mode: 'light', bg: '#f1e6c8', surface: '#faf3df', text: '#4a3a28', accent: '#a4442f', accent2: '#c0703a', frame: '#e4d4a8' },
  // Pine forest, mossy to teal.
  { id: 'forest',   name: 'Forest',   mode: 'dark',  bg: '#0f1d16', surface: '#16281e', text: '#dcebe0', accent: '#6fbf8f', accent2: '#a7d46f', frame: '#0c2a1c', frame2: '#0b2f33', angle: 135 },
  // A bright page under a deep-sea frame.
  { id: 'ocean',    name: 'Ocean',    mode: 'light', bg: '#e6f1f5', surface: '#f8fcfd', text: '#163440', accent: '#1f8aa8', accent2: '#2bb3a3', frame: '#0b4a5e', frame2: '#14608f', angle: 120 },
  // Showing off the extras: a gradient frame and two accents.
  { id: 'aurora',   name: 'Aurora',   mode: 'dark',  bg: '#0c1118', surface: '#141c26', text: '#e3ecf5', accent: '#4fd1c5', accent2: '#9f7aea', frame: '#0f2a33', frame2: '#2a1846', angle: 120 },
  { id: 'sunset',   name: 'Sunset',   mode: 'dark',  bg: '#1a1114', surface: '#24181c', text: '#f5e6e0', accent: '#ff9966', accent2: '#ff5e8a', frame: '#3a1a22', frame2: '#4a2a14', angle: 100 },
  { id: 'espresso', name: 'Espresso & Cream', mode: 'light', bg: '#f3ebe0', surface: '#fffaf3', text: '#3b2a1e', accent: '#a5683a', frame: '#2b1d14' },
];

const HEX = /^#[0-9a-f]{6}$/i;
const MAX_SAVED = 24;
const hex = (v) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null);

function luminance(color) {
  const n = parseInt(color.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const isDark = (color) => luminance(color) < 0.35;

/** A theme's colors, checked: the four base colors (falling back to Coffee's) plus any valid extras. */
function sanitizeCustom(c = {}) {
  const base = PRESETS[0];
  const out = {
    bg: hex(c.bg) || base.bg, surface: hex(c.surface) || base.surface,
    text: hex(c.text) || base.text, accent: hex(c.accent) || base.accent,
  };
  if (hex(c.accent2)) out.accent2 = hex(c.accent2);
  if (hex(c.frame)) out.frame = hex(c.frame);
  if (hex(c.frame2)) {
    out.frame2 = hex(c.frame2);
    const a = Math.round(Number(c.angle));
    out.angle = Number.isFinite(a) ? ((a % 360) + 360) % 360 : 135;
  }
  out.mode = isDark(out.bg) ? 'dark' : 'light';
  return out;
}

/** Keep only well-formed saved themes: { id, name, ...colors }. */
function sanitizeSaved(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const id = String(t.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
    if (!id || seen.has(id)) continue;
    const { mode, ...colors } = sanitizeCustom(t);
    const name = String(t.name || '').replace(/\s+/g, ' ').trim().slice(0, 32) || 'My theme';
    seen.add(id);
    out.push({ id, name, ...colors });
    if (out.length >= MAX_SAVED) break;
  }
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

  // The frame: the page background color, one color of its own, or a gradient.
  const from = t.frame || t.bg;
  const frame = t.frame2 ? `linear-gradient(${t.angle ?? 135}deg, ${from}, ${t.frame2})` : from;
  const custom = !!(t.frame || t.frame2);
  // Text on the frame stays readable: the theme's own text when the frame is
  // as dark (or light) as the theme, otherwise a near-white or near-black.
  const frameDark = t.frame2 ? (luminance(from) + luminance(t.frame2)) / 2 < 0.35 : isDark(from);
  const themeDark = t.mode === 'dark';
  const frameText = frameDark === themeDark ? t.text : frameDark ? '#f3efe9' : '#211d19';
  return {
    id: t.id,
    mode: t.mode,
    frame: custom,
    vars: {
      '--bg': t.bg,
      '--surface': t.surface,
      '--text': t.text,
      '--accent': t.accent,
      '--accent-2': t.accent2 || t.accent,
      '--on-accent': luminance(t.accent) > 0.4 ? '#141414' : '#ffffff',
      '--frame': frame,
      '--frame-text': frameText,
    },
  };
}

module.exports = { PRESETS, resolve, sanitizeCustom, sanitizeSaved, MAX_SAVED };
