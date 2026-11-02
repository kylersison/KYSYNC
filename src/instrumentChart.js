// Instrument charts: one chart per stem (drums, bass, guitar, keys, other/lead, vocals),
// all on the beat grid found in the full mix so every instrument lines up.
//
//   drums   → the same hit-based charter as the full mix, but on isolated drums, so
//             kick vs snare/hats (don vs ka) is much cleaner.
//   pitched → onsets from the stem, lane from pitch contour (higher note = further right),
//             sustained notes become holds.
//   vocals  → pitch tracked frame by frame, cut into sung notes, mostly holds.
//
// Pure functions, no DOM: runs in the analysis worker and in Node for tests.

import {
  spectralFlux, analyzeMix, mixChartJSON, gridSlots, pickNotes, buildCharts, percentile, round3,
} from './analysis.js';
import { decimate, yin, predominantPitch, lanesFromPitch } from './pitch.js';

/** Bump when instrument charting changes, so saved songs get re-charted. */
export const INSTRUMENT_CHART_VERSION = 1;

export const INSTRUMENT_ORDER = ['drums', 'bass', 'guitar', 'piano', 'other', 'vocals'];

const PITCHED = {
  //          subdivisions, notes per active beat, min gap (beats), 8th/16th weights, hold min (beats)
  easy:   { subs: [0],          perBeat: 0.35, gap: 1.75, w8: 0,    w16: 0,    hold: 1.5 },
  medium: { subs: [0, 2],       perBeat: 0.6,  gap: 0.9,  w8: 0.5,  w16: 0,    hold: 1 },
  hard:   { subs: [0, 2],       perBeat: 0.95, gap: 0.5,  w8: 0.75, w16: 0,    hold: 1 },
  expert: { subs: [0, 1, 2, 3], perBeat: 1.4,  gap: 0.25, w8: 0.85, w16: 0.55, hold: 0.75 },
};

const VOCAL = {
  easy:   { gap: 2,    hold: 1.5 },
  medium: { gap: 1,    hold: 1 },
  hard:   { gap: 0.5,  hold: 0.75 },
  expert: { gap: 0.25, hold: 0.5 },
};

const PITCH_RANGE = {
  bass: { yin: true, fmin: 30, fmax: 400 },
  guitar: { minMidi: 40, maxMidi: 88 },
  piano: { minMidi: 36, maxMidi: 96 },
  other: { minMidi: 36, maxMidi: 96 },
};

// ---------- helpers ----------

function frameIndex(flux) {
  return (t) => Math.round((t - flux.t0) / flux.hopSec);
}

/** Which flux frames have the stem actually playing (not bleed or silence). */
function activeFrames(flux, refLevel) {
  const p95 = percentile(flux.level, 0.95);
  const gate = Math.max(0.02 * refLevel, 0.1 * p95);
  const on = new Uint8Array(flux.level.length);
  for (let i = 0; i < on.length; i++) on[i] = flux.level[i] > gate ? 1 : 0;
  return { on, p95 };
}

/** Is there enough of this instrument in the song to make a chart? */
function isPresent(flux, beats, refLevel) {
  const { on, p95 } = activeFrames(flux, refLevel);
  if (p95 < 0.05 * refLevel) return { present: false, on };
  const fi = frameIndex(flux);
  let activeBeats = 0;
  for (let b = 0; b < beats.length - 1; b++) {
    const a = Math.max(0, fi(beats[b])), z = Math.min(on.length, fi(beats[b + 1]));
    let c = 0;
    for (let i = a; i < z; i++) c += on[i];
    if (z > a && c / (z - a) > 0.3) activeBeats++;
  }
  return { present: activeBeats >= Math.max(16, 0.1 * beats.length), on, activeBeats };
}

/** 16th-note grid times from tracked beats. */
function sixteenths(beats) {
  const out = [];
  for (let b = 0; b < beats.length - 1; b++) {
    const step = (beats[b + 1] - beats[b]) / 4;
    for (let k = 0; k < 4; k++) out.push(beats[b] + k * step);
  }
  if (beats.length) out.push(beats[beats.length - 1]);
  return out;
}

function nearestIndex(sorted, t) {
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < t) lo = m + 1; else hi = m; }
  if (lo > 0 && Math.abs(sorted[lo - 1] - t) <= Math.abs(sorted[lo] - t)) lo--;
  return lo;
}

/** Keep the highest-priority notes, at least `gap` seconds apart. */
function thinByPriority(notes, gap, priority) {
  const order = notes.slice().sort((a, b) => priority(b) - priority(a));
  const taken = []; // sorted times
  const kept = [];
  for (const n of order) {
    let lo = 0, hi = taken.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (taken[m] < n.time) lo = m + 1; else hi = m; }
    if ((lo < taken.length && taken[lo] - n.time < gap * 0.97) || (lo > 0 && n.time - taken[lo - 1] < gap * 0.97)) continue;
    kept.push(n);
    taken.splice(lo, 0, n.time);
  }
  return kept.sort((a, b) => a.time - b.time);
}

/** Taiko version of a pitched part: low half → don, high half → ka, long holds → drumrolls. */
function drumFromLanes(notes, beatLen, lanes) {
  const mid = (lanes - 1) / 2;
  return notes.map((n) => (n.duration >= 2 * beatLen
    ? { time: n.time, type: 'roll', duration: round3(n.duration) }
    : { time: n.time, type: n.lane <= mid ? 'don' : 'ka' }));
}

// ---------- pitched instruments ----------

export function chartPitched(name, x, rate, flux, beats, refLevel) {
  const { present, on, activeBeats } = isPresent(flux, beats, refLevel);
  if (!present) return null;
  const fi = frameIndex(flux);
  const beatLen = (beats[beats.length - 1] - beats[0]) / Math.max(1, beats.length - 1);
  const isOn = (t) => { const f = fi(t); return on[f] || on[f + 1] || on[f + 2]; };
  const slots = gridSlots(flux, beats).filter((s) => isOn(s.time + 0.02));
  const onsets = slots.filter((s) => s.strength >= 0.35).map((s) => s.time);

  // pitch, measured once per slot just after the attack
  const range = PITCH_RANGE[name] || PITCH_RANGE.other;
  const low = range.yin ? decimate(x, rate / 5512.5) : null;
  const lowRate = range.yin ? rate / Math.max(1, Math.round(rate / 5512.5)) : 0;
  const pitchCache = new Map();
  const pitchAt = (t) => {
    if (pitchCache.has(t)) return pitchCache.get(t);
    let p;
    if (range.yin) {
      const r = yin(low, lowRate, (t + 0.03) * lowRate, Math.round(0.09 * lowRate), range.fmin, range.fmax, 0.2);
      p = r.clarity > 0.5 ? r.midi : NaN;
    } else {
      const r = predominantPitch(x, rate, (t + 0.02) * rate, { size: 4096, minMidi: range.minMidi, maxMidi: range.maxMidi });
      p = r.clarity > 0.05 ? r.midi : NaN;
    }
    pitchCache.set(t, p);
    return p;
  };

  // How long the note rings: until the stem gets quiet, or the next attack
  const level = flux.level;
  const sustainOf = (t, limit) => {
    const f0 = Math.max(0, fi(t));
    let peak = 0;
    for (let f = f0; f < f0 + 4 && f < level.length; f++) peak = Math.max(peak, level[f]);
    const nextOnset = onsets.find((o) => o > t + 0.05) ?? Infinity;
    const end = Math.min(level.length, fi(Math.min(limit, nextOnset, t + 8 * beatLen)));
    let f = f0 + 3;
    while (f < end && level[f] > 0.4 * peak) f++;
    return Math.max(0, flux.t0 + f * flux.hopSec - t);
  };

  const difficulties = {}, drum = {};
  for (const [diff, cfg] of Object.entries(PITCHED)) {
    const picked = pickNotes(slots, cfg, beatLen, activeBeats);
    const lanes = diff === 'easy' ? 3 : 5;
    const laneOf = lanesFromPitch(picked.map((n) => n.time), picked.map((n) => pitchAt(n.time)), { lanes, window: 4 * beatLen });
    const notes = picked.map((n, i) => {
      const next = picked[i + 1]?.time ?? Infinity;
      let duration = 0;
      const sus = sustainOf(n.time, next);
      if (sus >= cfg.hold * beatLen) {
        const eighth = beatLen / 2;
        const room = Math.min(sus, next - n.time - beatLen / 4);
        duration = Math.floor(room / eighth) * eighth;
        if (duration < cfg.hold * beatLen) duration = 0;
      }
      return { time: round3(n.time), lane: laneOf[i] + (lanes === 3 ? 1 : 0), duration: round3(duration) };
    });
    difficulties[diff] = notes;
    drum[diff] = drumFromLanes(notes, beatLen, 5);
  }
  return { difficulties, drum };
}

// ---------- vocals ----------

/** Pitch track of a vocal stem → sung notes { time, end, pitch, level }. */
export function vocalNotes(x, rate, beats, refLevel) {
  const factor = Math.max(1, Math.round(rate / 11025));
  const v = decimate(x, factor);
  const sr = rate / factor;
  const hop = Math.round(0.016 * sr), win = Math.round(0.04 * sr);
  const frames = Math.max(0, Math.floor((v.length - win - Math.ceil(sr / 70) - 2) / hop));
  const lvl = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = 0; i < win; i++) { const a = v[f * hop + i]; s += a * a; }
    lvl[f] = Math.sqrt(s / win);
  }
  const p95 = percentile(lvl, 0.95);
  const gate = Math.max(0.02 * refLevel, 0.12 * p95);
  const midi = new Float32Array(frames).fill(NaN);
  for (let f = 0; f < frames; f++) {
    if (lvl[f] < gate) continue;
    const r = yin(v, sr, f * hop, win, 70, 1000, 0.2);
    if (r.clarity > 0.65) midi[f] = r.midi;
  }
  // median of 5 to remove octave blips
  const med = new Float32Array(frames).fill(NaN);
  for (let f = 0; f < frames; f++) {
    if (!Number.isFinite(midi[f])) continue;
    const w = [];
    for (let j = f - 2; j <= f + 2; j++) if (j >= 0 && j < frames && Number.isFinite(midi[j])) w.push(midi[j]);
    w.sort((a, b) => a - b);
    med[f] = w[w.length >> 1];
  }

  // Cut voiced runs into notes: a gap of 3+ unvoiced frames (~50 ms) ends a note,
  // and a pitch move of about a semitone that holds starts a new one.
  const tOf = (f) => (f * hop + win / 2) / sr;
  const segs = [];
  let cur = null, gapRun = 0;
  const close = (endF) => {
    if (cur && endF - cur.start >= 5) {
      const ps = cur.pitches.slice().sort((a, b) => a - b);
      segs.push({ time: tOf(cur.start), end: tOf(endF), pitch: ps[ps.length >> 1], level: cur.levelSum / cur.pitches.length });
    }
    cur = null;
  };
  for (let f = 0; f < frames; f++) {
    const p = med[f];
    if (!Number.isFinite(p)) {
      if (cur && ++gapRun >= 3) close(f - gapRun + 1);
      continue;
    }
    gapRun = 0;
    if (!cur) { cur = { start: f, pitches: [p], levelSum: lvl[f], ref: p }; continue; }
    // A new note = the pitch leaves by ~a semitone and stays there for ~130 ms on average,
    // so vibrato and scoops (which swing back) don't chop a long note into pieces.
    let moved = false;
    if (Math.abs(p - cur.ref) >= 0.8) {
      let sum = 0, n = 0, near = true;
      for (let k = 0; k < 8 && f + k < frames; k++) {
        const q = med[f + k];
        if (!Number.isFinite(q)) break;
        sum += q; n++;
        if (k < 4 && Math.abs(q - cur.ref) < 0.6) near = false;
      }
      moved = n >= 4 && near && Math.abs(sum / n - cur.ref) >= 0.9;
    }
    if (moved) {
      close(f);
      cur = { start: f, pitches: [p], levelSum: lvl[f], ref: p };
    } else {
      cur.pitches.push(p);
      cur.levelSum += lvl[f];
      // follow slow drift (vibrato, scoops) without splitting
      cur.ref = cur.ref * 0.85 + p * 0.15;
    }
  }
  close(frames);

  // Snap onto the 16th grid; two notes on the same slot → keep the longer.
  const grid = sixteenths(beats);
  if (grid.length < 2) return [];
  const bySlot = new Map();
  for (const s of segs) {
    const i = nearestIndex(grid, s.time);
    if (Math.abs(grid[i] - s.time) > 0.12) continue;
    const j = Math.max(i + 1, nearestIndex(grid, s.end));
    const note = { time: grid[i], end: grid[Math.min(j, grid.length - 1)], pitch: s.pitch, level: s.level };
    const prev = bySlot.get(i);
    if (!prev || note.end - note.time > prev.end - prev.time) bySlot.set(i, note);
  }
  const notes = [...bySlot.values()].sort((a, b) => a.time - b.time);
  for (let i = 0; i + 1 < notes.length; i++) notes[i].end = Math.min(notes[i].end, notes[i + 1].time);
  return notes;
}

export function chartVocals(x, rate, flux, beats, refLevel) {
  const { present } = isPresent(flux, beats, refLevel);
  if (!present) return null;
  const sung = vocalNotes(x, rate, beats, refLevel);
  if (sung.length < 16) return null;
  const beatLen = (beats[beats.length - 1] - beats[0]) / Math.max(1, beats.length - 1);

  const difficulties = {}, drum = {};
  for (const [diff, cfg] of Object.entries(VOCAL)) {
    const kept = thinByPriority(sung, cfg.gap * beatLen, (n) => (n.end - n.time + 0.1) * n.level);
    const lanes = diff === 'easy' ? 3 : 5;
    const laneOf = lanesFromPitch(kept.map((n) => n.time), kept.map((n) => n.pitch), { lanes, window: 4 * beatLen });
    const notes = kept.map((n, i) => {
      const next = kept[i + 1]?.time ?? Infinity;
      let duration = Math.min(n.end, next - beatLen / 4) - n.time;
      if (duration < cfg.hold * beatLen) duration = 0;
      return { time: round3(n.time), lane: laneOf[i] + (lanes === 3 ? 1 : 0), duration: round3(Math.max(0, duration)) };
    });
    difficulties[diff] = notes;
    drum[diff] = drumFromLanes(notes, beatLen, 5);
  }
  return { difficulties, drum };
}

// ---------- drums ----------

export function chartDrums(flux, beats, refLevel) {
  const { present } = isPresent(flux, beats, refLevel);
  if (!present) return null;
  const c = buildCharts(flux, beats);
  return { difficulties: c.highway, drum: c.drum };
}

// ---------- whole song ----------

/**
 * Chart a song that has stems.
 *   mix:   mono samples of the full song, or null (the stems are summed instead)
 *   stems: { drums, bass, vocals, other, guitar?, piano? } mono samples, same rate
 * Returns chart JSON: the full-song chart plus { instruments: { name: { difficulties, drum } } }.
 */
export function autoChartSong({ mix, stems, rate, meta = {} }, onProgress = () => {}) {
  const names = INSTRUMENT_ORDER.filter((n) => stems[n]);
  let mono = mix;
  if (!mono) {
    const len = Math.max(...names.map((n) => stems[n].length));
    mono = new Float32Array(len);
    for (const n of names) { const s = stems[n]; for (let i = 0; i < s.length; i++) mono[i] += s[i]; }
  }
  const { flux, beats, charts } = analyzeMix(mono, rate, (p) => onProgress(p * 0.3));
  const chart = mixChartJSON(charts, meta);
  const refLevel = percentile(flux.level, 0.95) || 1e-3;

  const instruments = {};
  names.forEach((name, i) => {
    const step = (a) => onProgress(0.3 + ((i + a) / names.length) * 0.7);
    const x = stems[name];
    const sf = spectralFlux(x, rate, (p) => step(p * 0.6));
    let c = null;
    if (name === 'drums') c = chartDrums(sf, beats, refLevel);
    else if (name === 'vocals') c = chartVocals(x, rate, sf, beats, refLevel);
    else c = chartPitched(name, x, rate, sf, beats, refLevel);
    if (c) instruments[name] = c;
    step(1);
  });
  chart.instruments = instruments;
  chart.instrumentsVersion = INSTRUMENT_CHART_VERSION;
  return chart;
}
