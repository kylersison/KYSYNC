// Pitch detection for instrument charts. Pure functions on Float32Array samples.
//
// - yin(): one fundamental frequency, for monophonic parts (bass, vocals).
// - predominantPitch(): the strongest pitch in a chord-y part (guitar, keys, synths),
//   by summing the energy at each candidate's harmonics.
// Pitches come back as MIDI note numbers (69 = A4 = 440 Hz), NaN when there's no clear pitch.

import { makeFFT } from './analysis.js';

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);

/** Average every `factor` samples (a cheap low-pass + downsample). */
export function decimate(x, factor) {
  factor = Math.max(1, Math.round(factor));
  if (factor === 1) return x;
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    const o = i * factor;
    for (let j = 0; j < factor; j++) s += x[o + j];
    out[i] = s / factor;
  }
  return out;
}

/**
 * YIN (de Cheveigné & Kawahara 2002) on x[start .. start+win+maxLag).
 * Returns { midi, clarity } where clarity is 1 - aperiodicity (1 = perfectly periodic).
 */
export function yin(x, rate, start, win, fmin, fmax, threshold = 0.15) {
  const minLag = Math.max(2, Math.floor(rate / fmax));
  const maxLag = Math.ceil(rate / fmin);
  start = Math.max(0, Math.floor(start));
  if (start + win + maxLag + 1 >= x.length) return { midi: NaN, clarity: 0 };

  const d = new Float64Array(maxLag + 2);
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    let s = 0;
    for (let j = 0; j < win; j++) {
      const v = x[start + j] - x[start + j + tau];
      s += v * v;
    }
    d[tau] = s;
  }
  // cumulative mean normalized difference
  const c = new Float64Array(maxLag + 2);
  c[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    run += d[tau];
    c[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let tau = -1;
  for (let t = minLag; t <= maxLag; t++) {
    if (c[t] < threshold) {
      while (t + 1 <= maxLag && c[t + 1] < c[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    // no dip under the threshold: take the global minimum, flagged by its clarity
    tau = minLag;
    for (let t = minLag + 1; t <= maxLag; t++) if (c[t] < c[tau]) tau = t;
  }
  const a = c[tau - 1], b = c[tau], e = c[tau + 1];
  const den = a - 2 * b + e;
  const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - e)) / den)) : 0;
  const lag = tau + shift;
  return { midi: hzToMidi(rate / lag), clarity: Math.max(0, 1 - b) };
}

const fftCache = new Map();
function fftOf(n) {
  if (!fftCache.has(n)) fftCache.set(n, makeFFT(n));
  return fftCache.get(n);
}

/**
 * Strongest pitch in a short window starting at sample `start`, by harmonic summation:
 * each candidate scores the (compressed) energy at its first harmonics, weighted toward
 * the lower ones so a note beats its own octave-below "ghost".
 */
export function predominantPitch(x, rate, start, { size = 4096, minMidi = 40, maxMidi = 88, harmonics = 6 } = {}) {
  start = Math.max(0, Math.floor(start));
  if (start + size > x.length) return { midi: NaN, clarity: 0 };
  const re = new Float64Array(size), im = new Float64Array(size);
  let energy = 0;
  for (let i = 0; i < size; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    re[i] = x[start + i] * w;
    energy += re[i] * re[i];
  }
  if (energy < 1e-9) return { midi: NaN, clarity: 0 };
  fftOf(size)(re, im);
  const half = size / 2;
  const mag = new Float64Array(half);
  for (let k = 1; k < half; k++) mag[k] = Math.sqrt(Math.hypot(re[k], im[k]));
  const binHz = rate / size;
  const peakNear = (hz) => {
    const k = hz / binHz;
    if (k >= half - 2) return 0;
    const lo = Math.max(1, Math.floor(k * 0.985)), hi = Math.min(half - 1, Math.ceil(k * 1.015));
    let m = 0;
    for (let j = lo; j <= hi; j++) if (mag[j] > m) m = mag[j];
    return m;
  };
  let best = -1, bestMidi = NaN, total = 0, count = 0;
  for (let m = minMidi; m <= maxMidi; m += 1 / 3) {
    const f0 = midiToHz(m);
    let s = 0;
    for (let h = 1; h <= harmonics; h++) s += 0.8 ** (h - 1) * peakNear(f0 * h);
    total += s; count++;
    if (s > best) { best = s; bestMidi = m; }
  }
  const mean = total / Math.max(1, count);
  return { midi: Math.round(bestMidi), clarity: mean > 0 ? Math.min(1, (best / mean - 1) / 3) : 0 };
}

/**
 * Lanes from a pitch line, the way Festival-style charts do it: relative, not absolute.
 * Within a few seconds around each note, distinct pitches are spread across the lanes
 * low → high, then each step is checked so a pitch going up never moves the note left
 * (and vice versa), and a repeated pitch stays in the same lane.
 */
export function lanesFromPitch(times, pitches, { lanes = 5, window = 4 } = {}) {
  const n = times.length;
  const semis = new Array(n);
  let last = NaN;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(pitches[i])) last = Math.round(pitches[i]);
    semis[i] = last;
  }
  // leading notes without a pitch take the first known one
  const firstKnown = semis.find(Number.isFinite) ?? 60;
  for (let i = 0; i < n && !Number.isFinite(semis[i]); i++) semis[i] = firstKnown;

  const out = new Array(n);
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    while (times[lo] < times[i] - window) lo++;
    while (hi + 1 < n && times[hi + 1] <= times[i] + window) hi++;
    const distinct = [...new Set(semis.slice(lo, hi + 1))].sort((a, b) => a - b);
    const k = distinct.length, r = distinct.indexOf(semis[i]);
    if (k <= 1) out[i] = Math.floor(lanes / 2);
    else if (k <= lanes) out[i] = r + Math.floor((lanes - k) / 2);
    else out[i] = Math.round((r / (k - 1)) * (lanes - 1));
  }
  for (let i = 1; i < n; i++) {
    if (semis[i] === semis[i - 1]) out[i] = out[i - 1];
    else if (semis[i] > semis[i - 1] && out[i] <= out[i - 1]) out[i] = Math.min(lanes - 1, out[i - 1] + 1);
    else if (semis[i] < semis[i - 1] && out[i] >= out[i - 1]) out[i] = Math.max(0, out[i - 1] - 1);
  }
  return out;
}
