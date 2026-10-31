// Washi paper theme: warm paper, sumi ink, forest green accent.
// Lane colors come from traditional Japanese dye colors.

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

/** Paint a washi texture (grain + long kozo fibers) onto an offscreen canvas. */
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
  for (let i = 0; i < grains; i++) {
    g.fillStyle = rand() > 0.5 ? 'rgba(120,100,70,0.055)' : 'rgba(255,255,255,0.15)';
    g.fillRect(rand() * w, rand() * h, 1, 1);
  }

  // Kozo fibers: sparse, gently curving, mostly pale
  const fibers = Math.floor((w * h) / 5800);
  g.lineCap = 'round';
  for (let i = 0; i < fibers; i++) {
    let x = rand() * w, y = rand() * h;
    let a = rand() * Math.PI * 2;
    const len = 40 + rand() * 90;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < len; s += 6) {
      a += (rand() - 0.5) * 0.3;
      x += Math.cos(a) * 6; y += Math.sin(a) * 6;
      g.lineTo(x, y);
    }
    const dark = rand() < 0.1;
    g.strokeStyle = dark ? 'rgba(150,128,92,0.08)' : 'rgba(255,253,247,0.25)';
    g.lineWidth = 0.4 + rand() * 0.8;
    g.stroke();
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
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
