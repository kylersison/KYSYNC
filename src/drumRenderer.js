// Drum mode renderer (Taiko style): notes scroll right → left into a target circle.
// The drum on the left lights up per side: D = left rim, F = left center, J = right center, K = right rim.

import { Renderer, beatLines } from './renderer.js';
import { THEME, DRUM_COLORS, GRADE_STYLE, shade, roundRect, drawKeycap } from './theme.js';

const KEY_INFO = [
  { label: 'D', kind: 'ka', side: 'L' },
  { label: 'F', kind: 'don', side: 'L' },
  { label: 'J', kind: 'don', side: 'R' },
  { label: 'K', kind: 'ka', side: 'R' },
];

function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export class DrumRenderer extends Renderer {
  constructor(canvas) {
    super(canvas);
    this.drumFlash = { kaL: 0, donL: 0, donR: 0, kaR: 0 };
    this.bursts = [];
    this.rollCount = 0;
    this.rollShow = 0;
  }

  resize() {
    super.resize();
    const w = this.w, h = this.h;
    this.laneH = Math.max(90, Math.min(h * 0.22, 170));
    this.laneY = h * 0.42;
    this.panelW = Math.max(150, Math.min(w * 0.2, 230));
    this.hitX = this.panelW + this.laneH * 0.62;
    this.noteR = this.laneH * 0.22;
    this.bigR = this.laneH * 0.31;
  }

  xFor(dt, lookahead) {
    return this.hitX + (dt / lookahead) * (this.w - this.hitX + this.bigR);
  }

  consumeEvents(events) {
    for (const e of events) {
      if (e.type === 'drum') {
        this.drumFlash[e.kind + e.side] = 1;
      } else if (e.type === 'hit') {
        this.bursts.push({ kind: e.kind, big: e.big, age: 0 });
        this.popups.push({ ...GRADE_STYLE[e.grade], age: 0 });
      } else if (e.type === 'miss') {
        this.popups.push({ ...GRADE_STYLE.miss, age: 0 });
      } else if (e.type === 'bigBonus') {
        this.popups.push({ text: 'BIG!', color: DRUM_COLORS[e.kind], age: 0.05 });
        this.bursts.push({ kind: e.kind, big: true, age: 0 });
      } else if (e.type === 'roll') {
        this.rollCount++;
        this.rollShow = 1;
        this.bursts.push({ kind: 'roll', big: false, age: 0.15 });
      } else if (e.type === 'rollEnd') {
        this.rollCount = 0;
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

    g.drawImage(this.paper, 0, 0, this.w, this.h);

    const top = this.laneY - this.laneH / 2, bot = this.laneY + this.laneH / 2;

    // Lane band
    g.fillStyle = alpha(THEME.paperDeep, 0.9);
    g.fillRect(this.panelW, top, this.w - this.panelW, this.laneH);
    g.strokeStyle = THEME.ink;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(this.panelW, top); g.lineTo(this.w, top);
    g.moveTo(this.panelW, bot); g.lineTo(this.w, bot);
    g.stroke();

    // Beat lines
    for (const line of beatLines(state, t - 0.2, t + lookahead)) {
      const x = this.xFor(line.time - t, lookahead);
      if (x < this.panelW) continue;
      g.strokeStyle = alpha(THEME.ink, line.bar ? 0.3 : 0.1);
      g.lineWidth = line.bar ? 1.5 : 1;
      g.beginPath(); g.moveTo(x, top + 4); g.lineTo(x, bot - 4); g.stroke();
    }

    // Target circle
    g.strokeStyle = alpha(THEME.ink, 0.55);
    g.lineWidth = 2;
    g.beginPath(); g.arc(this.hitX, this.laneY, this.bigR + 2, 0, Math.PI * 2); g.stroke();
    g.fillStyle = alpha(THEME.paper, 0.7);
    g.beginPath(); g.arc(this.hitX, this.laneY, this.noteR + 2, 0, Math.PI * 2); g.fill();
    g.strokeStyle = THEME.ink;
    g.lineWidth = 2.5;
    g.stroke();

    // Notes: draw later notes first so earlier ones sit on top
    if (judge) {
      g.save();
      try {
      g.beginPath(); g.rect(this.panelW, top - this.bigR, this.w - this.panelW, this.laneH + this.bigR * 2); g.clip();
      const notes = judge.notes;
      for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        const dt = n.time - t;
        if (dt > lookahead * 1.05) continue;
        if (n.kind === 'roll') {
          if (n.time + n.duration - t < -0.3) continue;
          this._drawRoll(n, t, lookahead);
          continue;
        }
        if (dt < -0.3) continue;
        if (n.result && n.result !== 'miss') continue;
        this._drawNote(this.xFor(dt, lookahead), n.kind, n.big, n.result === 'miss');
      }
      } finally {
        g.restore();
      }
    }

    // Hit bursts at the target
    for (const b of this.bursts) {
      b.age += frameDt;
      const p = b.age / 0.35;
      const color = b.kind === 'roll' ? DRUM_COLORS.roll : DRUM_COLORS[b.kind];
      g.strokeStyle = alpha(color, Math.max(0, 1 - p));
      g.lineWidth = (b.big ? 6 : 4) * (1 - p) + 1;
      const r = (b.big ? this.bigR : this.noteR) * (1 + p * 0.9);
      g.beginPath(); g.arc(this.hitX, this.laneY, r, 0, Math.PI * 2); g.stroke();
    }
    this.bursts = this.bursts.filter((b) => b.age < 0.35);

    this._drawDrumPanel(keysDown, judge);

    // Judgement popups above the target
    g.textAlign = 'center';
    for (const p of this.popups) {
      p.age += frameDt;
      g.globalAlpha = Math.max(0, 1 - p.age / 0.5);
      g.fillStyle = p.color;
      g.font = `700 ${Math.round(this.laneH * 0.2)}px ${THEME.font}`;
      g.fillText(p.text, this.hitX, top - 14 - p.age * 50);
    }
    g.globalAlpha = 1;
    this.popups = this.popups.filter((p) => p.age < 0.5);

    // Drumroll counter
    if (this.rollShow > 0) {
      g.globalAlpha = Math.min(1, this.rollShow * 2);
      g.fillStyle = shade(DRUM_COLORS.roll, -0.25);
      g.font = `700 ${Math.round(this.laneH * 0.24)}px ${THEME.fontDisplay}`;
      g.textAlign = 'left';
      g.fillText(`連打 ${this.rollCount || ''}`, this.hitX + this.bigR + 16, top - 14);
      g.globalAlpha = 1;
      this.rollShow = Math.max(0, this.rollShow - frameDt * 1.2);
    }

    for (const k in this.drumFlash) this.drumFlash[k] = Math.max(0, this.drumFlash[k] - frameDt * 6);

    if (judge) this._drawHud(judge, t, duration, title, difficulty);

    if (t < 0) {
      const n = Math.ceil(-t);
      g.fillStyle = THEME.ink;
      g.font = `800 ${Math.round(this.h * 0.12)}px ${THEME.fontDisplay}`;
      g.textAlign = 'center';
      if (n > 0) g.fillText(String(n), (this.w + this.panelW) / 2, this.laneY + this.laneH * 1.6);
    }
  }

  // A drum note: a dyed disc on a darker base with a paper ring, like a keycap seen from above
  _drawNote(x, kind, big, missed) {
    const g = this.g;
    const R = big ? this.bigR : this.noteR;
    const color = missed ? THEME.missed : DRUM_COLORS[kind];
    const y = this.laneY;
    g.fillStyle = 'rgba(60, 45, 20, 0.18)';
    g.beginPath(); g.arc(x + 1, y + R * 0.22 + 2, R, 0, Math.PI * 2); g.fill();
    g.fillStyle = shade(color, -0.3);
    g.beginPath(); g.arc(x, y + R * 0.18, R, 0, Math.PI * 2); g.fill();
    g.fillStyle = color;
    g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = THEME.paperLight;
    g.lineWidth = R * 0.16;
    g.beginPath(); g.arc(x, y, R * 0.86, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = alpha(THEME.ink, 0.6);
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.stroke();
    g.fillStyle = `rgba(255, 250, 238, ${missed ? 0.12 : 0.35})`;
    g.beginPath(); g.ellipse(x - R * 0.12, y - R * 0.38, R * 0.42, R * 0.16, -0.2, 0, Math.PI * 2); g.fill();
  }

  _drawRoll(n, t, lookahead) {
    const g = this.g;
    const done = n.result === 'roll';
    const x0 = Math.max(this.xFor(n.time - t, lookahead), this.hitX);
    const x1 = this.xFor(n.time + n.duration - t, lookahead);
    if (x1 <= x0) return; // roll already passed the drum
    const R = this.noteR;
    const y = this.laneY;
    const color = done ? THEME.missed : DRUM_COLORS.roll;

    g.fillStyle = shade(color, -0.3);
    roundRect(g, x0 - R, y - R + R * 0.18, x1 - x0 + 2 * R, 2 * R, R); g.fill();
    g.fillStyle = color;
    roundRect(g, x0 - R, y - R, x1 - x0 + 2 * R, 2 * R, R); g.fill();
    g.strokeStyle = alpha(THEME.ink, 0.6);
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = 'rgba(255, 250, 238, 0.3)';
    roundRect(g, x0 - R * 0.6, y - R * 0.6, x1 - x0 + R * 1.2, R * 0.3, R * 0.15); g.fill();
    this._drawNote(x0, 'roll', false, done);
  }

  _drawDrumPanel(keysDown, judge) {
    const g = this.g;
    const cx = this.panelW / 2, cy = this.laneY;
    const R = this.laneH * 0.46;

    // Panel background, a slightly deeper sheet
    g.fillStyle = alpha(THEME.paperDeep, 0.55);
    g.fillRect(0, this.laneY - this.laneH / 2, this.panelW, this.laneH);
    g.strokeStyle = THEME.ink;
    g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(this.panelW, this.laneY - this.laneH / 2); g.lineTo(this.panelW, this.laneY + this.laneH / 2); g.stroke();

    // Drum body (wood) and rim halves
    g.fillStyle = shade(DRUM_COLORS.wood, -0.2);
    g.beginPath(); g.arc(cx, cy + R * 0.08, R, 0, Math.PI * 2); g.fill();
    const half = (side, r0, r1, color, a) => {
      const s = side === 'L' ? Math.PI / 2 : -Math.PI / 2;
      g.beginPath();
      g.arc(cx, cy, r1, s, s + Math.PI);
      if (r0 > 0) g.arc(cx, cy, r0, s + Math.PI, s, true); else g.lineTo(cx, cy);
      g.closePath();
      g.fillStyle = color;
      g.globalAlpha = a;
      g.fill();
      g.globalAlpha = 1;
    };
    const f = this.drumFlash;
    // rim
    half('L', R * 0.72, R, DRUM_COLORS.wood, 1);
    half('R', R * 0.72, R, DRUM_COLORS.wood, 1);
    half('L', R * 0.72, R, DRUM_COLORS.ka, Math.max(f.kaL, keysDown[0] ? 0.8 : 0));
    half('R', R * 0.72, R, DRUM_COLORS.ka, Math.max(f.kaR, keysDown[3] ? 0.8 : 0));
    // face
    half('L', 0, R * 0.72, THEME.paperLight, 1);
    half('R', 0, R * 0.72, THEME.paperLight, 1);
    half('L', 0, R * 0.72, DRUM_COLORS.don, Math.max(f.donL, keysDown[1] ? 0.8 : 0));
    half('R', 0, R * 0.72, DRUM_COLORS.don, Math.max(f.donR, keysDown[2] ? 0.8 : 0));
    g.strokeStyle = THEME.ink;
    g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cx, cy, R * 0.72, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = alpha(THEME.ink, 0.35);
    g.beginPath(); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();

    // Combo in the middle of the drum
    if (judge && judge.combo >= 2) {
      g.fillStyle = THEME.ink;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `800 ${Math.round(R * (judge.combo >= 100 ? 0.42 : 0.55))}px ${THEME.fontDisplay}`;
      g.fillText(String(judge.combo), cx, cy);
      g.textBaseline = 'alphabetic';
    }

    // Keycaps under the drum
    const kw = Math.min(46, this.panelW / 4.6), kh = kw * 0.62, gap = kw * 0.18;
    const totalW = kw * 4 + gap * 3;
    const ky = this.laneY + this.laneH / 2 + kh * 0.9 + 6;
    KEY_INFO.forEach((k, i) => {
      const x = cx - totalW / 2 + kw / 2 + i * (kw + gap);
      drawKeycap(g, x, ky, kw, kh, DRUM_COLORS[k.kind], keysDown[i], k.label);
    });
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
    const mult = judge.multiplier;
    g.fillText(`${(judge.accuracy * 100).toFixed(1)}%   ×${mult}`, pad, pad + 54);

    g.textAlign = 'right';
    g.fillStyle = THEME.ink;
    g.font = `600 17px ${THEME.fontDisplay}`;
    g.fillText(title || '', this.w - pad, pad + 18);
    g.fillStyle = THEME.accent;
    g.font = `500 12px ${THEME.font}`;
    g.fillText(`DRUM · ${(difficulty || '').toUpperCase()}`, this.w - pad, pad + 38);

    if (duration > 0) {
      const p = Math.max(0, Math.min(1, t / duration));
      g.fillStyle = THEME.inkFaint;
      g.fillRect(0, 0, this.w, 3);
      g.fillStyle = THEME.accent;
      g.fillRect(0, 0, this.w * p, 3);
    }
  }
}
