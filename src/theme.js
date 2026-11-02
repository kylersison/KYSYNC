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
  for (let i = 0; i < grains; i++) {
    g.fillStyle = rand() > 0.5 ? 'rgba(120,100,70,0.045)' : 'rgba(255,255,255,0.12)';
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
  g.fillStyle = 'rgba(60, 45, 20, 0.18)';
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
    g.fillStyle = 'rgba(255, 255, 255, 0.55)';
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
    g.fillStyle = 'rgba(60, 45, 20, 0.18)';
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
