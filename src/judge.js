// Judge: owns note state, hit detection, scoring and combo.
// Pure logic with no DOM or audio, so it can be unit tested in Node.
//
// All times are in seconds on the song clock (0 = start of the audio file).

import {
  LANE_COUNT, WINDOWS, POINTS, ACCURACY_WEIGHT, SUSTAIN_POINTS_PER_SEC,
  HOLD_RELEASE_GRACE, COMBO_PER_MULT, MAX_MULT,
} from './constants.js';

export function gradeFor(absDelta) {
  if (absDelta <= WINDOWS.perfect) return 'perfect';
  if (absDelta <= WINDOWS.great) return 'great';
  if (absDelta <= WINDOWS.good) return 'good';
  return null;
}

export class Judge {
  constructor(notes) {
    this.notes = notes
      .map((n, i) => ({
        id: i,
        time: n.time,
        lane: n.lane,
        duration: n.duration || 0,
        result: null,       // 'perfect' | 'great' | 'good' | 'miss'
        delta: 0,           // hit time - note time (negative = early)
        holdState: null,    // 'held' | 'broken' | 'done'
        sustainScored: 0,   // seconds of sustain already scored
      }))
      .sort((a, b) => a.time - b.time || a.lane - b.lane);

    this.lanes = Array.from({ length: LANE_COUNT }, () => []);
    for (const n of this.notes) this.lanes[n.lane].push(n);
    this.cursor = new Array(LANE_COUNT).fill(0);
    this.activeHolds = new Set();

    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.counts = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.deltas = [];
    this.events = []; // drained by the renderer for popups / effects

    const last = this.notes[this.notes.length - 1];
    this.lastNoteEnd = last ? Math.max(...this.notes.map(n => n.time + n.duration)) : 0;
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

  // Skip judged notes and auto-miss notes whose window has closed.
  // Returns the next note that can still be hit in this lane.
  _advance(lane, t) {
    const list = this.lanes[lane];
    let i = this.cursor[lane];
    while (i < list.length) {
      const n = list[i];
      if (n.result) { i++; continue; }
      if (t - n.time > WINDOWS.good) { this._miss(n); i++; continue; }
      break;
    }
    this.cursor[lane] = i;
    return list[i] || null;
  }

  _miss(n) {
    n.result = 'miss';
    this.counts.miss++;
    this.combo = 0;
    this.events.push({ type: 'miss', lane: n.lane });
  }

  _scoreSustain(n, t) {
    const held = Math.min(t, n.time + n.duration) - n.time;
    if (held > n.sustainScored) {
      this.score += (held - n.sustainScored) * SUSTAIN_POINTS_PER_SEC * this.multiplier;
      n.sustainScored = held;
    }
  }

  /** Call every frame with the current (offset-corrected) song time. */
  update(t) {
    for (let lane = 0; lane < LANE_COUNT; lane++) this._advance(lane, t);
    for (const n of this.activeHolds) {
      this._scoreSustain(n, t);
      if (t >= n.time + n.duration) {
        n.holdState = 'done';
        this.activeHolds.delete(n);
        this.events.push({ type: 'holdDone', lane: n.lane });
      }
    }
  }

  /** Key pressed. Returns the note that was hit, or null for a ghost tap. */
  press(lane, t) {
    const n = this._advance(lane, t);
    if (!n) return null;
    const delta = t - n.time;
    const grade = gradeFor(Math.abs(delta));
    if (!grade) return null; // too early: no penalty

    n.result = grade;
    n.delta = delta;
    this.cursor[lane]++; // n was at the cursor
    this.counts[grade]++;
    this.score += POINTS[grade] * this.multiplier;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.deltas.push(delta);
    this.events.push({ type: 'hit', lane, grade, delta });

    if (n.duration > 0) {
      n.holdState = 'held';
      this.activeHolds.add(n);
    }
    return n;
  }

  /** Key released. Ends any hold in that lane. */
  release(lane, t) {
    for (const n of this.activeHolds) {
      if (n.lane !== lane) continue;
      const end = n.time + n.duration;
      if (t < end - HOLD_RELEASE_GRACE) {
        this._scoreSustain(n, t);
        n.holdState = 'broken';
        this.events.push({ type: 'holdBreak', lane });
      } else {
        this._scoreSustain(n, end);
        n.holdState = 'done';
        this.events.push({ type: 'holdDone', lane });
      }
      this.activeHolds.delete(n);
    }
  }

  isFinished() {
    return this.activeHolds.size === 0 &&
      this.lanes.every((list, lane) => this.cursor[lane] >= list.length);
  }
}
