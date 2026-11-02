// Colors and drawing helpers. The default is the washi paper theme (warm paper, sumi ink,
// forest green, lane colors from traditional Japanese dyes); src/themes.js swaps these
// values in place for other presets or a custom theme, so every import sees the change.

export const THEME = {
  paper: '#ebdfc4',       // kinari: warm unbleached washi
  paperLight: '#f6efe0',  // keycap tops
  paperDeep: '#ddcfae',   // highway surface
  fiber: '#c9b893',
  ink: '#2a2722',         // sumi
  inkSoft: 'rgba(42, 39, 34, 0.55)',
  inkFaint: 'rgba(42, 39, 34, 0.14)',
  accent: '#2f5a3c',      // forest green
  accentSoft: '#5f8a63',
  missed: '#b9ae97',
  shadow: 'rgba(60, 45, 20, 0.18)', // under keycaps and notes
  gloss: 'rgba(255, 255, 255, 0.55)', // sheen on keycap tops
  grain: 1,                          // paper texture strength, 0..1
  scenery: 1,                        // ink mountains strength, 0 = off
  font: '"Zen Kaku Gothic New", system-ui, sans-serif',
  fontDisplay: '"Shippori Mincho", "Zen Kaku Gothic New", serif',
};

// 若竹 forest green · 朱 vermilion · 山吹 gold · 藍 indigo · 柿 persimmon
export const LANE_COLORS = ['#2f6b45', '#c0442e', '#c99a22', '#2c4f7c', '#d0702c'];

export const GRADE_STYLE = {
  perfect: { text: 'PERFECT', color: THEME.accent },
  great: { text: 'GREAT', color: '#2c4f7c' },
  good: { text: 'GOOD', color: '#a87d14' },
  miss: { text: 'MISS', color: '#b03a28' },
};

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paint a washi texture (fine grain only) onto an offscreen canvas. */
export function makePaper(w, h, dpr = 1, base = THEME.paper) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const rand = rng(42);

  g.fillStyle = base;
  g.fillRect(0, 0, w, h);

  // Grain
  const grains = Math.floor((w * h) / 45);
  const k = THEME.grain;
  if (k <= 0) return c;
  for (let i = 0; i < grains; i++) {
    g.fillStyle = rand() > 0.5 ? `rgba(120,100,70,${0.045 * k})` : `rgba(255,255,255,${0.12 * k})`;
    g.fillRect(rand() * w, rand() * h, 1, 1);
  }

  return c;
}

// ---- color + shape helpers ----

export function shade(hex, amount) {
  // amount < 0 darkens toward black, > 0 lightens toward white
  const n = parseInt(hex.slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount));
  return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`;
}

export function roundRect(g, x, y, w, h, r) {
  w = Math.max(0, w); h = Math.max(0, h);
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Drum (Taiko) colors
export const DRUM_COLORS = {
  don: '#c0442e',   // vermilion: center hits
  ka: '#2c4f7c',    // indigo: rim hits
  roll: '#c99a22',  // yamabuki gold: drumrolls
  wood: '#8a6a45',
};

/** A keycap: colored base, paper top that sinks when pressed. (cx, cy) is the top's center. */
export function drawKeycap(g, cx, cy, w, h, color, pressed, label, font) {
  const r = h * 0.3, depth = h * 0.3, sink = pressed ? depth * 0.7 : 0;
  const x = cx - w / 2, y = cy - h / 2;
  g.fillStyle = THEME.shadow;
  roundRect(g, x + 1, y + depth + 3, w, h, r); g.fill();
  g.fillStyle = shade(color, -0.18);
  roundRect(g, x, y + depth, w, h, r); g.fill();
  roundRect(g, x, y + sink, w, h, r);
  g.fillStyle = pressed ? color : THEME.paperLight;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = color;
  g.stroke();
  if (!pressed) {
    g.fillStyle = THEME.gloss;
    roundRect(g, x + w * 0.12, y + 3, w * 0.76, h * 0.14, h * 0.07); g.fill();
  }
  if (label) {
    g.fillStyle = pressed ? THEME.paperLight : color;
    g.font = `700 ${Math.round(h * 0.5)}px ${font || THEME.font}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, cx, cy + sink + 1);
    g.textBaseline = 'alphabetic';
  }
}

/**
 * The big count in the play area: the lead-in before a song starts (t < 0), or the
 * 3-2-1 after unpausing (state.countdown = seconds left). The resume count sits on a
 * paper disc with a green ring that drains each second, so it reads over moving notes.
 */
export function drawCountdown(g, state, x, y, h) {
  const left = state.countdown ?? (state.t < 0 ? -state.t : 0);
  if (!(left > 0)) return;
  const n = Math.ceil(left);
  const frac = n - left; // 0 when this number appears → 1 just before the next
  const size = Math.round(h * 0.12);
  const cy = y - size * 0.36;
  g.save();
  g.textAlign = 'center';
  if (state.countdown != null) {
    const r = size * 0.78;
    g.fillStyle = THEME.shadow;
    g.beginPath(); g.arc(x + 2, cy + 4, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = THEME.paperLight;
    g.beginPath(); g.arc(x, cy, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = THEME.inkFaint;
    g.lineWidth = 2;
    g.stroke();
    g.strokeStyle = THEME.accent;
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.beginPath(); g.arc(x, cy, r - 6, -Math.PI / 2, -Math.PI / 2 + (1 - frac) * Math.PI * 2); g.stroke();
  }
  g.fillStyle = THEME.ink;
  g.font = `800 ${Math.round(size * (1.06 - 0.06 * frac))}px ${THEME.fontDisplay}`;
  g.fillText(String(n), x, y);
  g.restore();
}

/**
 * Swap in a theme's colors (all '#rrggbb'). Everything that draws reads THEME, LANE_COLORS,
 * DRUM_COLORS and GRADE_STYLE at draw time, so changes show up on the next frame.
 */
export function applyThemeColors(t) {
  const dark = luminance(t.bg) < 0.35;
  Object.assign(THEME, {
    paper: t.bg,
    paperDeep: t.surface,
    paperLight: t.cap,
    ink: t.ink,
    inkSoft: rgba(t.ink, 0.6),
    inkFaint: rgba(t.ink, 0.14),
    accent: t.accent,
    accentSoft: mix(t.accent, t.bg, 0.35),
    missed: t.missed,
    shadow: dark ? 'rgba(0, 0, 0, 0.4)' : 'rgba(60, 45, 20, 0.18)',
    gloss: dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.55)',
    grain: t.grain,
  });
  LANE_COLORS.splice(0, LANE_COLORS.length, ...t.lanes);
  Object.assign(DRUM_COLORS, { don: t.don, ka: t.ka, roll: t.roll, wood: t.wood });
  GRADE_STYLE.perfect.color = t.accent;
  GRADE_STYLE.great.color = t.ka;
  GRADE_STYLE.good.color = t.roll;
  GRADE_STYLE.miss.color = t.don;
}

// ---- color math (hex in, CSS colors out) ----

export function rgbOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

export function rgba(hex, a) {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Blend two hex colors; amount 0 = a, 1 = b. Returns hex. */
export function mix(a, b, amount) {
  const x = rgbOf(a), y = rgbOf(b);
  return '#' + x.map((c, i) => Math.round(c + (y[i] - c) * amount).toString(16).padStart(2, '0')).join('');
}

/** Relative luminance, 0 (black) .. 1 (white). */
export function luminance(hex) {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgbOf(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---- scenery ----

// Mountain ridges: each layer is a few sines summed into peaks, so the range is endless
// and never repeats visibly. [base height (fraction of screen), ink alpha, drift px/s, roughness]
const RIDGES = [
  [0.58, 0.035, 3, 0.8],
  [0.70, 0.055, 6, 1],
  [0.83, 0.08, 11, 1.25],
];

function ridgeY(x, i, h, rough) {
  // 1 - |sin| has a sharp point on top, so the ridges peak like brush-drawn mountains.
  const peak = (f, ph) => (1 - Math.abs(Math.sin(x * f + ph))) ** 1.6;
  const a = peak(0.0019, i * 1.7) * 0.12
    + peak(0.0053, i * 4.1) * 0.045 * rough
    + Math.sin(x * 0.019 + i) * 0.005 * rough;
  return a * h;
}

/**
 * Sumi-e mountains in layers along the bottom of the screen, drifting slowly sideways,
 * far ranges paler than near ones like mist. Drawn in the theme's ink color, so they're
 * dark hills on light themes and pale ones on dark themes. THEME.scenery 0 turns them off.
 */
export function drawMountains(g, w, h, time) {
  const k = THEME.scenery;
  if (!(k > 0)) return;
  const step = Math.max(6, Math.round(w / 220));
  RIDGES.forEach(([base, a, speed, rough], i) => {
    const shift = time * speed;
    g.fillStyle = rgba(THEME.ink, a * k * (THEME.dark ? 0.8 : 1));
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w + step; x += step) g.lineTo(x, h * base - ridgeY(x + shift + i * 900, i, h, rough));
    g.lineTo(w, h);
    g.closePath();
    g.fill();
  });
}
