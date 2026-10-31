// Canvas renderer: perspective note highway, gems, holds, HUD.
// Washi theme: paper texture, sumi ink lines, dye-colored notes.

import { LANE_COUNT, LANE_LABELS } from './constants.js';
import { THEME, LANE_COLORS, GRADE_STYLE, makePaper, shade, roundRect } from './theme.js';

const FOCAL = 1;
const Z_FAR = 3; // higher = steeper perspective
const S_FAR = FOCAL / (FOCAL + Z_FAR);

/**
 * Beat lines visible between tStart and tEnd: [{ time, bar }].
 * Uses the song's tracked beats when it has them (auto-charted songs), else bpm + offset.
 */
export function beatLines({ beats, barPhase = 0, bpm, offset = 0 }, tStart, tEnd) {
  const out = [];
  if (beats && beats.length) {
    let lo = 0, hi = beats.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (beats[m] < tStart) lo = m + 1; else hi = m; }
    for (let i = lo; i < beats.length && beats[i] <= tEnd; i++) {
      out.push({ time: beats[i], bar: ((i - barPhase) % 4 + 4) % 4 === 0 });
    }
    return out;
  }
  if (!bpm) return out;
  const beat = 60 / bpm;
  for (let k = Math.ceil((tStart - offset) / beat); offset + k * beat <= tEnd; k++) {
    out.push({ time: offset + k * beat, bar: ((k % 4) + 4) % 4 === 0 });
  }
  return out;
}

const laneCenter = (lane) => -1 + (2 * lane + 1) / LANE_COUNT;
const laneEdge = (i) => -1 + (2 * i) / LANE_COUNT;

// '#rrggbb' + alpha → rgba()
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.popups = [];
    this.flash = new Array(LANE_COUNT).fill(0);
    this.lastFrame = performance.now();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cx = this.w / 2;
    this.hitY = this.h * 0.84;
    this.horizonY = this.h * 0.1;
    this.half = Math.min(this.w * 0.44, 340);
    this.paper = makePaper(this.w, this.h, dpr);
  }

  /** dt: seconds until the note reaches the hit line. x: -1..1 across the highway. */
  project(dt, x, lookahead) {
    const d = Math.max(dt / lookahead, -0.2);
    const s = FOCAL / (FOCAL + d * Z_FAR);
    const t = (1 - s) / (1 - S_FAR);
    return { x: this.cx + x * this.half * s, y: this.hitY - t * (this.hitY - this.horizonY), s };
  }

  _quad(dtA, dtB, x0, x1, look) {
    const a0 = this.project(dtA, x0, look), a1 = this.project(dtA, x1, look);
    const b1 = this.project(dtB, x1, look), b0 = this.project(dtB, x0, look);
    const g = this.g;
    g.beginPath();
    g.moveTo(a0.x, a0.y); g.lineTo(a1.x, a1.y); g.lineTo(b1.x, b1.y); g.lineTo(b0.x, b0.y);
    g.closePath();
  }

  _line(dt0, x0, dt1, x1, look) {
    const a = this.project(dt0, x0, look), b = this.project(dt1, x1, look);
    const g = this.g;
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    return a;
  }

  consumeEvents(events) {
    for (const e of events) {
      if (e.type === 'hit') {
        this.flash[e.lane] = 1;
        this.popups.push({ lane: e.lane, ...GRADE_STYLE[e.grade], age: 0 });
      } else if (e.type === 'miss') {
        this.popups.push({ lane: e.lane, ...GRADE_STYLE.miss, age: 0 });
      }
    }
    events.length = 0;
  }

  draw(state) {
    const { t, judge, lookahead, keysDown, duration, title, difficulty } = state;
    const g = this.g;
    const now = performance.now();
    const frameDt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (judge) this.consumeEvents(judge.events);

    // Paper background
    g.drawImage(this.paper, 0, 0, this.w, this.h);

    const look = lookahead;
    const bottom = -0.035 * look; // a sliver of highway below the hit line

    // Highway: a deeper sheet of paper laid on top, fading into the distance
    this._quad(bottom, look, -1, 1, look);
    const hw = g.createLinearGradient(0, this.horizonY, 0, this.hitY);
    hw.addColorStop(0, alpha(THEME.paperDeep, 0));
    hw.addColorStop(0.5, alpha(THEME.paperDeep, 0.6));
    hw.addColorStop(1, alpha(THEME.paperDeep, 0.95));
    g.fillStyle = hw;
    g.fill();

    // Lane press wash (like ink bleeding into paper)
    for (let l = 0; l < LANE_COUNT; l++) {
      if (!keysDown[l]) continue;
      this._quad(bottom, look * 0.6, laneEdge(l), laneEdge(l + 1), look);
      const grad = g.createLinearGradient(0, this.horizonY, 0, this.hitY);
      grad.addColorStop(0, alpha(LANE_COLORS[l], 0));
      grad.addColorStop(1, alpha(LANE_COLORS[l], 0.16));
      g.fillStyle = grad;
      g.fill();
    }

    // Beat lines
    for (const line of beatLines(state, t + bottom, t + look)) {
      const dt = line.time - t;
      const fade = 1 - Math.max(0, dt / look);
      g.strokeStyle = alpha(THEME.ink, (line.bar ? 0.28 : 0.1) * fade);
      g.lineWidth = line.bar ? 1.5 : 1;
      this._line(dt, -1, dt, 1, look);
    }

    // Lane dividers + edges in ink, fading toward the horizon
    for (let i = 0; i <= LANE_COUNT; i++) {
      const x = laneEdge(i);
      const edge = i === 0 || i === LANE_COUNT;
      const a = this.project(bottom, x, look), b = this.project(look, x, look);
      const grad = g.createLinearGradient(0, b.y, 0, a.y);
      grad.addColorStop(0, alpha(THEME.ink, 0));
      grad.addColorStop(1, alpha(THEME.ink, edge ? 0.75 : 0.16));
      g.strokeStyle = grad;
      g.lineWidth = edge ? 2.5 : 1;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }

    // Hit line: a brush-weight ink stroke
    g.strokeStyle = THEME.ink;
    g.lineWidth = 2.5;
    this._line(0, -1.02, 0, 1.02, look);

    for (let l = 0; l < LANE_COUNT; l++) this._drawTarget(l, keysDown[l], look);

    // Notes (far → near so near notes are on top)
    if (judge) {
      const notes = judge.notes;
      for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        const dtHead = n.time - t;
        const dtEnd = n.time + n.duration - t;
        if (dtHead > look || dtEnd < bottom) continue;
        if (n.duration > 0) this._drawHold(n, t, look, bottom);
        const hit = n.result && n.result !== 'miss';
        if (!hit && dtHead >= bottom) this._drawGem(n.lane, dtHead, look, n.result === 'miss');
      }
    }

    // Hit bursts: an expanding ink ring
    for (let l = 0; l < LANE_COUNT; l++) {
      if (this.flash[l] <= 0) continue;
      const p = this.project(0, laneCenter(l), look);
      const r = (1.4 - this.flash[l]) * this.half * 0.22;
      g.strokeStyle = alpha(LANE_COLORS[l], this.flash[l] * 0.9);
      g.lineWidth = 3 * this.flash[l] + 1;
      g.beginPath(); g.ellipse(p.x, p.y, r, r * 0.4, 0, 0, Math.PI * 2); g.stroke();
      this.flash[l] = Math.max(0, this.flash[l] - frameDt * 4);
    }

    // Active holds glow
    if (judge) {
      for (const n of judge.activeHolds) {
        const p = this.project(0, laneCenter(n.lane), look);
        g.fillStyle = alpha(LANE_COLORS[n.lane], 0.25 + 0.2 * Math.sin(now / 50));
        g.beginPath(); g.ellipse(p.x, p.y - this.half * 0.06, this.half * 0.17, this.half * 0.07, 0, 0, Math.PI * 2); g.fill();
      }
    }

    // Judgement popups
    g.textAlign = 'center';
    for (const p of this.popups) {
      p.age += frameDt;
      const pos = this.project(0, laneCenter(p.lane), look);
      g.globalAlpha = Math.max(0, 1 - p.age / 0.5);
      g.fillStyle = p.color;
      g.font = `700 ${Math.round(this.half * 0.07)}px ${THEME.font}`;
      g.fillText(p.text, pos.x, pos.y - this.half * 0.18 - p.age * 60);
    }
    g.globalAlpha = 1;
    this.popups = this.popups.filter((p) => p.age < 0.5);

    if (judge) this._drawHud(judge, t, duration, title, difficulty);

    // Lead-in countdown
    if (t < 0) {
      const n = Math.ceil(-t);
      g.fillStyle = THEME.ink;
      g.font = `800 ${Math.round(this.h * 0.12)}px ${THEME.fontDisplay}`;
      g.textAlign = 'center';
      if (n > 0) g.fillText(String(n), this.cx, this.h * 0.42);
    }
  }

  // Lane targets are keycaps sitting on the hit line; pressing pushes them down.
  _drawTarget(lane, pressed, look) {
    const g = this.g;
    const p = this.project(0, laneCenter(lane), look);
    const laneW = (this.half * 2) / LANE_COUNT;
    const w = laneW * 0.76, h = laneW * 0.36, r = h * 0.3;
    const depth = h * 0.3;
    const sink = pressed ? depth * 0.7 : 0;
    const c = LANE_COLORS[lane];
    const x = p.x - w / 2, y = p.y - h / 2;

    // shadow on the paper, then the key's side wall
    g.fillStyle = 'rgba(60, 45, 20, 0.18)';
    roundRect(g, x + 1, y + depth + 3, w, h, r); g.fill();
    g.fillStyle = shade(c, -0.18);
    roundRect(g, x, y + depth, w, h, r); g.fill();

    // key top
    roundRect(g, x, y + sink, w, h, r);
    g.fillStyle = pressed ? c : THEME.paperLight;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = c;
    g.stroke();
    if (!pressed) {
      // soft sheen along the top edge
      g.fillStyle = 'rgba(255, 255, 255, 0.55)';
      roundRect(g, x + w * 0.12, y + 3, w * 0.76, h * 0.14, h * 0.07); g.fill();
    }

    g.fillStyle = pressed ? THEME.paperLight : c;
    g.font = `700 ${Math.round(h * 0.5)}px ${THEME.font}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(LANE_LABELS[lane], p.x, p.y + sink + 1);
    g.textBaseline = 'alphabetic';
  }

  // Notes are small dyed tiles with a darker edge and a highlight strip.
  _drawGem(lane, dt, look, missed) {
    const g = this.g;
    const p = this.project(dt, laneCenter(lane), look);
    const laneW = ((this.half * 2) / LANE_COUNT) * p.s;
    const w = laneW * 0.72, h = w * 0.34, d = h * 0.32, r = h * 0.32;
    const c = missed ? THEME.missed : LANE_COLORS[lane];
    const x = p.x - w / 2, y = p.y - h / 2;

    g.fillStyle = 'rgba(60, 45, 20, 0.16)';
    roundRect(g, x + 1, y + d + 2, w, h, r); g.fill();
    g.fillStyle = missed ? shade(THEME.missed, -0.15) : shade(c, -0.3);
    roundRect(g, x, y + d, w, h, r); g.fill();
    g.fillStyle = c;
    roundRect(g, x, y, w, h, r); g.fill();
    g.fillStyle = `rgba(255, 250, 238, ${missed ? 0.15 : 0.38})`;
    roundRect(g, x + w * 0.08, y + h * 0.16, w * 0.84, h * 0.22, h * 0.11); g.fill();
  }

  _drawHold(n, t, look, bottom) {
    if (n.holdState === 'done') return;
    const g = this.g;
    const held = n.holdState === 'held';
    const dead = n.result === 'miss' || n.holdState === 'broken';
    const start = Math.max(held ? 0 : n.time - t, bottom);
    const end = Math.min(n.time + n.duration - t, look);
    if (end <= start) return;
    const c = laneCenter(n.lane);
    this._quad(start, end, c - 0.07, c + 0.07, look);
    g.fillStyle = dead ? alpha('#a89e88', 0.5) : alpha(LANE_COLORS[n.lane], held ? 0.85 : 0.55);
    g.fill();
  }

  _drawHud(judge, t, duration, title, difficulty) {
    const g = this.g;
    const pad = 24;
    g.textAlign = 'left';
    g.fillStyle = THEME.ink;
    g.font = `700 34px ${THEME.fontDisplay}`;
    g.fillText(Math.floor(judge.score).toLocaleString(), pad, pad + 30);
    g.font = `500 15px ${THEME.font}`;
    g.fillStyle = THEME.inkSoft;
    g.fillText(`${(judge.accuracy * 100).toFixed(1)}%`, pad, pad + 54);

    // Combo + multiplier, left of the hit line
    const left = this.cx - this.half - 16;
    g.textAlign = 'right';
    g.font = `700 ${judge.combo >= 10 ? 40 : 32}px ${THEME.fontDisplay}`;
    g.fillStyle = THEME.ink;
    if (judge.combo > 1) g.fillText(String(judge.combo), left, this.hitY - 30);
    const mult = judge.multiplier;
    g.font = `700 24px ${THEME.font}`;
    g.fillStyle = mult >= 4 ? LANE_COLORS[1] : mult >= 2 ? THEME.accent : THEME.inkSoft;
    g.fillText(`×${mult}`, left, this.hitY + 4);

    // Title / difficulty
    g.textAlign = 'right';
    g.fillStyle = THEME.ink;
    g.font = `600 17px ${THEME.fontDisplay}`;
    g.fillText(title || '', this.w - pad, pad + 18);
    g.fillStyle = THEME.accent;
    g.font = `500 12px ${THEME.font}`;
    g.fillText((difficulty || '').toUpperCase(), this.w - pad, pad + 38);

    // Progress: a thin green thread across the top
    if (duration > 0) {
      const p = Math.max(0, Math.min(1, t / duration));
      g.fillStyle = THEME.inkFaint;
      g.fillRect(0, 0, this.w, 3);
      g.fillStyle = THEME.accent;
      g.fillRect(0, 0, this.w * p, 3);
    }
  }
}
