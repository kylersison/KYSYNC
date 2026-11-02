// Themes: presets, your saved custom themes, and applying one to both the canvas and the menus.
//
// A theme is plain data, every color '#rrggbb':
//   { name, bg, surface, cap, ink, accent, missed, lanes: [5], don, ka, roll, wood, grain, brightness }
//   bg = page/paper, surface = highway & drum lane, cap = keycap tops & panels,
//   ink = text & lines, grain = paper texture 0..1, brightness = whole-screen dimmer 0.5..1.

import { THEME, applyThemeColors, makePaper, rgbOf, rgba, mix, shade, luminance } from './theme.js';

export const PRESETS = [
  {
    id: 'washi', name: 'Washi', note: 'Warm paper, the original',
    bg: '#ebdfc4', surface: '#ddcfae', cap: '#f6efe0', ink: '#2a2722', accent: '#2f5a3c', missed: '#b9ae97',
    lanes: ['#2f6b45', '#c0442e', '#c99a22', '#2c4f7c', '#d0702c'],
    don: '#c0442e', ka: '#2c4f7c', roll: '#c99a22', wood: '#8a6a45', grain: 1, brightness: 1,
  },
  {
    id: 'lamplight', name: 'Lamplight', note: 'Dimmer paper, less glare',
    bg: '#b8ac92', surface: '#aa9e83', cap: '#cdc2ab', ink: '#2b2620', accent: '#2e5a3b', missed: '#918670',
    lanes: ['#2b6140', '#a83c29', '#a37b17', '#2a4a73', '#b0602a'],
    don: '#a83c29', ka: '#2a4a73', roll: '#a37b17', wood: '#6f5537', grain: 0.7, brightness: 1,
  },
  {
    id: 'sumi', name: 'Sumi', note: 'Dark ink, warm and soft',
    bg: '#1c1a17', surface: '#25221e', cap: '#322e28', ink: '#e3d9c6', accent: '#82b08b', missed: '#4f493f',
    lanes: ['#6fae83', '#d9755e', '#d8b25a', '#7096c6', '#dc8f57'],
    don: '#d9755e', ka: '#7096c6', roll: '#d8b25a', wood: '#5c4a36', grain: 0.4, brightness: 1,
  },
  {
    id: 'yoru', name: 'Yoru', note: 'Night blue, cool and calm',
    bg: '#141a24', surface: '#1a2230', cap: '#263044', ink: '#d6dde8', accent: '#8ab4dc', missed: '#3e4757',
    lanes: ['#6cbf9b', '#e07a7a', '#e2c06a', '#7aa7e8', '#c99ae6'],
    don: '#e07a7a', ka: '#7aa7e8', roll: '#e2c06a', wood: '#3f4a5e', grain: 0.25, brightness: 1,
  },
  {
    id: 'matcha', name: 'Matcha', note: 'Muted green, low contrast',
    bg: '#272d27', surface: '#2e352e', cap: '#3b433a', ink: '#dfe4d4', accent: '#a7c58b', missed: '#525a4f',
    lanes: ['#93c47d', '#e39b7b', '#e3cb78', '#8fb3d9', '#c8a2d4'],
    don: '#e39b7b', ka: '#8fb3d9', roll: '#e3cb78', wood: '#5a5040', grain: 0.3, brightness: 1,
  },
  {
    id: 'contrast', name: 'High contrast', note: 'Black, white, bright notes',
    bg: '#000000', surface: '#0e0e0e', cap: '#1c1c1c', ink: '#ffffff', accent: '#00d97a', missed: '#5a5a5a',
    lanes: ['#00d97a', '#ff4d4d', '#ffd400', '#3fa9ff', '#ff8c1a'],
    don: '#ff4d4d', ka: '#3fa9ff', roll: '#ffd400', wood: '#4a4a4a', grain: 0, brightness: 1,
  },
];

const KEY = 'kysync.theme';           // the theme in use (full object)
const SAVED_KEY = 'kysync.themes';    // your saved custom themes
const SCENERY_KEY = 'kysync.scenery'; // ink mountains: { on, strength } (works with any theme)

const load = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const HEX = /^#[0-9a-f]{6}$/i;
const COLOR_KEYS = ['bg', 'surface', 'cap', 'ink', 'accent', 'missed', 'don', 'ka', 'roll', 'wood'];

/** Fill gaps from Washi so a hand-edited or older saved theme can't break drawing. */
export function cleanTheme(t) {
  const base = PRESETS[0];
  const out = { id: t?.id || 'custom', name: String(t?.name || 'Custom').slice(0, 40) };
  for (const k of COLOR_KEYS) out[k] = HEX.test(t?.[k]) ? t[k].toLowerCase() : base[k];
  out.lanes = base.lanes.map((c, i) => (HEX.test(t?.lanes?.[i]) ? t.lanes[i].toLowerCase() : c));
  out.grain = Number.isFinite(+t?.grain) ? Math.max(0, Math.min(1, +t.grain)) : base.grain;
  out.brightness = Number.isFinite(+t?.brightness) ? Math.max(0.5, Math.min(1, +t.brightness)) : 1;
  return out;
}

export const themes = {
  current: cleanTheme(load(KEY, PRESETS[0])),
  saved: load(SAVED_KEY, []).map(cleanTheme),
  listeners: new Set(),

  onChange(fn) { this.listeners.add(fn); },

  /** Use a theme (and remember it). */
  use(t, { persist = true } = {}) {
    this.current = cleanTheme(t);
    applyTheme(this.current);
    // Tweaking one of your saved themes updates it in place.
    const i = this.saved.findIndex((s) => s.id === this.current.id);
    if (i >= 0 && persist) { this.saved[i] = this.current; save(SAVED_KEY, this.saved); }
    if (persist) save(KEY, this.current);
    for (const fn of this.listeners) fn(this.current);
  },

  /** Save the current colors as a named custom theme. */
  saveAs(name) {
    const t = { ...cleanTheme(this.current), id: `custom-${Date.now()}`, name: name.trim().slice(0, 40) || 'My theme' };
    this.saved.push(t);
    save(SAVED_KEY, this.saved);
    this.use(t);
    return t;
  },

  remove(id) {
    this.saved = this.saved.filter((t) => t.id !== id);
    save(SAVED_KEY, this.saved);
  },

  all() {
    return [...PRESETS, ...this.saved];
  },

  /** Ink mountains are a setting of their own, so switching themes keeps your choice. */
  scenery: (() => {
    const s = load(SCENERY_KEY, { on: true, strength: 1 });
    return { on: s.on !== false, strength: Math.max(0.1, Math.min(1, +s.strength || 1)) };
  })(),

  setScenery(patch) {
    Object.assign(this.scenery, patch);
    save(SCENERY_KEY, this.scenery);
    THEME.scenery = this.scenery.on ? this.scenery.strength : 0;
    for (const fn of this.listeners) fn(this.current);
  },
};
THEME.scenery = themes.scenery.on ? themes.scenery.strength : 0;

/** Push a theme into the canvas colors, the menu CSS, and the screen dimmer. */
export function applyTheme(t) {
  applyThemeColors(t);
  const dark = luminance(t.bg) < 0.35;
  const onAccent = luminance(t.accent) > 0.4 ? mix(t.bg, '#000000', 0.4) : t.cap;
  const rgb = (hex) => rgbOf(hex).join(', ');
  const vars = {
    '--paper': t.bg,
    '--paper-light': t.cap,
    '--paper-panel': mix(t.bg, t.cap, 0.55),
    '--paper-deep': t.surface,
    '--ink': t.ink,
    '--ink-soft': rgba(t.ink, 0.62),
    '--ink-line': rgba(t.ink, 0.18),
    '--ink-rgb': rgb(t.ink),
    '--shadow-rgb': dark ? '0, 0, 0' : '80, 60, 30',
    '--forest': t.accent,
    '--forest-dark': shade(t.accent, -0.3),
    '--forest-hover': mix(t.accent, dark ? '#ffffff' : '#000000', 0.1),
    '--forest-wash': rgba(t.accent, 0.12),
    '--forest-rgb': rgb(t.accent),
    '--on-accent': onAccent,
    '--vermilion': t.don,
    '--indigo': t.ka,
    '--gold': t.roll,
    '--overlay': rgba(t.surface, dark ? 0.55 : 0.45),
    '--hover': mix(t.cap, '#ffffff', dark ? 0.06 : 0.45),
    '--song-active': mix(t.cap, t.accent, 0.1),
    '--sheen': dark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.7)',
    '--grain-layer': t.grain > 0.05 ? 'var(--grain)' : 'none',
  };
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
  root.setProperty('color-scheme', dark ? 'dark' : 'light');
  // Menu panels use the same generated washi as the game canvas, a little lighter.
  root.setProperty('--washi', t.grain > 0.05
    ? `url(${makePaper(520, 760, 1, mix(t.bg, t.cap, 0.55)).toDataURL()})`
    : 'none');
  document.body.style.filter = t.brightness < 0.999 ? `brightness(${t.brightness})` : '';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.bg);
  THEME.dark = dark;
}
