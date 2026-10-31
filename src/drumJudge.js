// DrumJudge: Taiko-style judging.
//   D = ka (rim, left)   F = don (center, left)   J = don (center, right)   K = ka (rim, right)
// Note types: don, ka, bigDon, bigKa, roll.
// - Hitting the wrong drum inside a note's window counts as a miss (no button mashing).
// - Big notes: hit once for normal points; hit the other side of the same drum within
//   BIG_BONUS_WINDOW for double points.
// - Rolls: every hit during the roll scores; rolls never break combo.
// Same public shape as Judge, so game.js can use either.

import { WINDOWS, POINTS, ACCURACY_WEIGHT, COMBO_PER_MULT, MAX_MULT } from './constants.js';
import { gradeFor } from './judge.js';

export const DRUM_KEYS = [
  { kind: 'ka', side: 'L' },  // D
  { kind: 'don', side: 'L' }, // F
  { kind: 'don', side: 'R' }, // J
  { kind: 'ka', side: 'R' },  // K
];

export const BIG_BONUS_WINDOW = 0.05;
export const ROLL_POINTS = 30;

export const kindOf = (type) =>
  type === 'roll' ? 'roll' : type === 'don' || type === 'bigDon' ? 'don' : 'ka';
export const isBig = (type) => type === 'bigDon' || type === 'bigKa';

export class DrumJudge {
  constructor(notes) {
    this.notes = notes
      .map((n, i) => ({
        id: i,
        time: n.time,
        type: n.type,
        kind: kindOf(n.type),
        big: isBig(n.type),
        duration: n.type === 'roll' ? Math.max(0.1, n.duration || 0) : 0,
        result: null,     // perfect | great | good | miss | roll
        delta: 0,
        bonus: false,     // big note hit with both sides
        rollHits: 0,
      }))
      .sort((a, b) => a.time - b.time);

    this.hittable = this.notes.filter((n) => n.kind !== 'roll');
    this.rolls = this.notes.filter((n) => n.kind === 'roll');
    this.cursor = 0;
    this.lastBig = null;
    this.lastT = -Infinity;

    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.counts = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.rollHits = 0;
    this.deltas = [];
    this.events = [];
    this.activeHolds = new Set(); // unused; keeps the Judge interface

    this.lastNoteEnd = this.notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0);
  }

  get multiplier() {
    return Math.min(MAX_MULT, 1 + Math.floor(this.combo / COMBO_PER_MULT));
  }

  get judged() {
    const c = this.counts;
    return c.perfect + c.great + c.good + c.miss;
  }

  get accuracy() {
    const total = this.judged;
    if (!total) return 1;
    let sum = 0;
    for (const k in this.counts) sum += this.counts[k] * ACCURACY_WEIGHT[k];
    return sum / total;
  }

  get meanDeltaMs() {
    if (!this.deltas.length) return 0;
    return (this.deltas.reduce((a, b) => a + b, 0) / this.deltas.length) * 1000;
  }

  _miss(n) {
    n.result = 'miss';
    this.counts.miss++;
    this.combo = 0;
    this.events.push({ type: 'miss', kind: n.kind });
  }

  _advance(t) {
    while (this.cursor < this.hittable.length) {
      const n = this.hittable[this.cursor];
      if (n.result) { this.cursor++; continue; }
      if (t - n.time > WINDOWS.good) { this._miss(n); this.cursor++; continue; }
      break;
    }
    return this.hittable[this.cursor] || null;
  }

  update(t) {
    this.lastT = t;
    this._advance(t);
    for (const r of this.rolls) {
      if (!r.result && t > r.time + r.duration) {
        r.result = 'roll';
        this.events.push({ type: 'rollEnd', hits: r.rollHits });
      }
    }
  }

  /** lane: 0..3 for D F J K. Returns the note affected, or null. */
  press(lane, t) {
    const key = DRUM_KEYS[lane];
    if (!key) return null;
    const { kind, side } = key;
    this.events.push({ type: 'drum', kind, side });

    // Second hand on a big note → bonus
    const lb = this.lastBig;
    if (lb && !lb.note.bonus && lb.kind === kind && lb.side !== side && t - lb.at <= BIG_BONUS_WINDOW) {
      lb.note.bonus = true;
      this.score += POINTS[lb.note.result] * this.multiplier;
      this.events.push({ type: 'bigBonus', kind });
      return lb.note;
    }

    // Drumroll in progress: any drum counts
    for (const r of this.rolls) {
      if (t >= r.time - WINDOWS.good && t <= r.time + r.duration) {
        r.rollHits++;
        this.rollHits++;
        this.score += ROLL_POINTS * this.multiplier;
        this.events.push({ type: 'roll', kind });
        return r;
      }
    }

    const n = this._advance(t);
    if (!n) return null;
    const delta = t - n.time;
    const grade = gradeFor(Math.abs(delta));
    if (!grade) return null; // too early: ghost tap

    this.cursor++;
    if (n.kind !== kind) {
      this._miss(n); // wrong drum
      return n;
    }

    n.result = grade;
    n.delta = delta;
    this.counts[grade]++;
    this.score += POINTS[grade] * this.multiplier;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.deltas.push(delta);
    this.events.push({ type: 'hit', kind, grade, big: n.big });
    if (n.big) this.lastBig = { note: n, kind, side, at: t };
    return n;
  }

  release() {}

  isFinished() {
    return this.cursor >= this.hittable.length && this.rolls.every((r) => r.result);
  }
}
