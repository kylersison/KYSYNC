// Canvas renderer: perspective note highway, gems, holds, HUD.

import { LANE_COUNT, LANE_COLORS, LANE_LABELS } from './constants.js';

const GRADE_STYLE = {
  perfect: { text: 'PERFECT', color: '#7cf7ff' },
  great: { text: 'GREAT', color: '#9dff7c' },
  good: { text: 'GOOD', color: '#ffd23f' },
  miss: { text: 'MISS', color: '#ff5470' },
};

const FOCAL = 1;
const Z_FAR = 3; // higher = steeper perspective
const S_FAR = FOCAL / (FOCAL + Z_FAR);

const laneCenter = (lane) => -1 + (2 * lane + 1) / LANE_COUNT;
const laneEdge = (i) => -1 + (2 * i) / LANE_COUNT;

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
    const { t, judge, lookahead, keysDown, bpm, offset, duration, title, difficulty } = state;
    const g = this.g;
    const now = performance.now();
    const frameDt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (judge) this.consumeEvents(judge.events);

    // Background
    const bg = g.createLinearGradient(0, 0, 0, this.h);
    bg.addColorStop(0, '#07060f');
    bg.addColorStop(1, '#161033');
    g.fillStyle = bg;
    g.fillRect(0, 0, this.w, this.h);

    const look = lookahead;
    const bottom = -0.035 * look; // a sliver of highway below the hit line

    // Highway surface
    this._quad(bottom, look, -1, 1, look);
    const hw = g.createLinearGradient(0, this.horizonY, 0, this.hitY);
    hw.addColorStop(0, 'rgba(30,24,70,0.15)');
    hw.addColorStop(1, 'rgba(36,28,84,0.95)');
    g.fillStyle = hw;
    g.fill();

    // Lane press glow
    for (let l = 0; l < LANE_COUNT; l++) {
      if (!keysDown[l]) continue;
      this._quad(bottom, look, laneEdge(l), laneEdge(l + 1), look);
      const grad = g.createLinearGradient(0, this.horizonY, 0, this.hitY);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(1, LANE_COLORS[l] + '33');
      g.fillStyle = grad;
      g.fill();
    }

    // Beat lines
    if (bpm) {
      const beat = 60 / bpm;
      const first = Math.ceil((t + bottom - offset) / beat);
      const last = Math.floor((t + look - offset) / beat);
      for (let k = first; k <= last; k++) {
        const dt = offset + k * beat - t;
        const a = this.project(dt, -1, look), b = this.project(dt, 1, look);
        const isBar = ((k % 4) + 4) % 4 === 0;
        g.strokeStyle = isBar ? 'rgba(180,170,255,0.35)' : 'rgba(180,170,255,0.12)';
        g.lineWidth = (isBar ? 2 : 1) * a.s;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      }
    }

    // Lane dividers + edges
    for (let i = 0; i <= LANE_COUNT; i++) {
      const x = laneEdge(i);
      const a = this.project(bottom, x, look), b = this.project(look, x, look);
      g.strokeStyle = i === 0 || i === LANE_COUNT ? 'rgba(160,140,255,0.7)' : 'rgba(160,140,255,0.18)';
      g.lineWidth = i === 0 || i === LANE_COUNT ? 3 : 1;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }

    // Hit line
    {
      const a = this.project(0, -1, look), b = this.project(0, 1, look);
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }

    // Targets
    for (let l = 0; l < LANE_COUNT; l++) this._drawTarget(l, keysDown[l], look);

    // Notes (draw far → near so near notes are on top)
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

    // Flash bursts
    for (let l = 0; l < LANE_COUNT; l++) {
      if (this.flash[l] <= 0) continue;
      const p = this.project(0, laneCenter(l), look);
      const r = (1.4 - this.flash[l]) * this.half * 0.22;
      g.strokeStyle = LANE_COLORS[l];
      g.globalAlpha = this.flash[l];
      g.lineWidth = 4;
      g.beginPath(); g.ellipse(p.x, p.y, r, r * 0.4, 0, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
      this.flash[l] = Math.max(0, this.flash[l] - frameDt * 4);
    }

    // Active holds sparkle
    if (judge) {
      for (const n of judge.activeHolds) {
        const p = this.project(0, laneCenter(n.lane), look);
        g.fillStyle = LANE_COLORS[n.lane];
        g.globalAlpha = 0.5 + 0.5 * Math.sin(now / 40);
        g.beginPath(); g.ellipse(p.x, p.y, this.half * 0.14, this.half * 0.05, 0, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 1;
      }
    }

    // Judgement popups
    g.textAlign = 'center';
    for (const p of this.popups) {
      p.age += frameDt;
      const pos = this.project(0, laneCenter(p.lane), look);
      g.globalAlpha = Math.max(0, 1 - p.age / 0.5);
      g.fillStyle = p.color;
      g.font = `700 ${Math.round(this.half * 0.075)}px Oxanium, system-ui, sans-serif`;
      g.fillText(p.text, pos.x, pos.y - this.half * 0.18 - p.age * 60);
    }
    g.globalAlpha = 1;
    this.popups = this.popups.filter((p) => p.age < 0.5);

    if (judge) this._drawHud(judge, t, duration, title, difficulty);

    // Lead-in countdown
    if (t < 0) {
      const n = Math.ceil(-t);
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.font = `800 ${Math.round(this.h * 0.12)}px Oxanium, system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillText(n > 0 ? String(n) : '', this.cx, this.h * 0.42);
    }
  }

  _drawTarget(lane, pressed, look) {
    const g = this.g;
    const p = this.project(0, laneCenter(lane), look);
    const w = (this.half * 2) / LANE_COUNT;
    const rx = w * 0.38, ry = rx * 0.38;
    g.lineWidth = 3;
    g.strokeStyle = LANE_COLORS[lane];
    g.fillStyle = pressed ? LANE_COLORS[lane] : 'rgba(10,8,25,0.85)';
    g.beginPath(); g.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = pressed ? '#0b0918' : 'rgba(255,255,255,0.8)';
    g.font = `700 ${Math.round(ry * 1.1)}px Oxanium, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(LANE_LABELS[lane], p.x, p.y + 1);
    g.textBaseline = 'alphabetic';
  }

  _drawGem(lane, dt, look, missed) {
    const g = this.g;
    const p = this.project(dt, laneCenter(lane), look);
    const w = ((this.half * 2) / LANE_COUNT) * p.s;
    const rx = w * 0.4, ry = rx * 0.36;
    const color = missed ? '#55506e' : LANE_COLORS[lane];
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath(); g.ellipse(p.x, p.y + ry * 0.35, rx, ry, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = color;
    g.beginPath(); g.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = missed ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.75)';
    g.beginPath(); g.ellipse(p.x, p.y - ry * 0.25, rx * 0.55, ry * 0.3, 0, 0, Math.PI * 2); g.fill();
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
    const half = 0.07;
    this._quad(start, end, c - half, c + half, look);
    g.fillStyle = dead ? 'rgba(85,80,110,0.6)' : LANE_COLORS[n.lane] + (held ? 'ee' : '99');
    g.fill();
  }

  _drawHud(judge, t, duration, title, difficulty) {
    const g = this.g;
    const pad = 24;
    g.textAlign = 'left';
    g.fillStyle = '#fff';
    g.font = `800 34px Oxanium, system-ui, sans-serif`;
    g.fillText(Math.floor(judge.score).toLocaleString(), pad, pad + 30);
    g.font = `500 15px Oxanium, system-ui, sans-serif`;
    g.fillStyle = 'rgba(255,255,255,0.65)';
    g.fillText(`${(judge.accuracy * 100).toFixed(1)}%`, pad, pad + 54);

    // Combo + multiplier, left of the hit line
    const left = this.cx - this.half - 16;
    g.textAlign = 'right';
    g.font = `800 ${judge.combo >= 10 ? 40 : 32}px Oxanium, system-ui, sans-serif`;
    g.fillStyle = '#fff';
    if (judge.combo > 1) g.fillText(String(judge.combo), left, this.hitY - 30);
    const mult = judge.multiplier;
    g.font = `800 24px Oxanium, system-ui, sans-serif`;
    g.fillStyle = ['#fff', '#fff', '#7cf7ff', '#ffd23f', '#ff8a3d'][mult];
    g.fillText(`×${mult}`, left, this.hitY + 4);

    // Title / difficulty
    g.textAlign = 'right';
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = `600 16px Oxanium, system-ui, sans-serif`;
    g.fillText(title || '', this.w - pad, pad + 18);
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.font = `500 13px Oxanium, system-ui, sans-serif`;
    g.fillText((difficulty || '').toUpperCase(), this.w - pad, pad + 38);

    // Progress bar
    if (duration > 0) {
      const p = Math.max(0, Math.min(1, t / duration));
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(0, 0, this.w, 4);
      g.fillStyle = '#9d7cff';
      g.fillRect(0, 0, this.w * p, 4);
    }
  }
}
