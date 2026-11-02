// Auto-charting: turn raw audio samples into a chart.
//
//   1. Short-time FFT → spectral flux (how much new energy appears each ~12 ms),
//      split into a low band (kick drums, bass) and a high band (snares, hats, claps).
//   2. Tempo: autocorrelate the flux to find the beat period, then fine-tune BPM and
//      beat phase by checking which grid lines up best with the whole song.
//   3. Onsets: peaks in the flux, snapped to a 16th-note grid.
//   4. Notes: the strongest onsets become notes. Drum mode: low-heavy → don, bright → ka.
//      Highway mode: lane by spectral centroid (low sounds left, high sounds right).
//
// Pure functions, no DOM: runs in a Web Worker in the browser and in Node for tests.
// Assumes a steady tempo, which fits most studio-recorded pop, rock, EDM and J-pop.

/** Bump when the charting changes, so saved songs get re-charted automatically. */
export const CHART_VERSION = 2;

const TARGET_RATE = 22050;
const N = 1024;   // FFT size (~46 ms)
const HOP = 256;  // ~11.6 ms

// ---------- FFT ----------

export function makeFFT(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const tr = re[i + j + half] * cos[k] + im[i + j + half] * sin[k];
          const ti = -re[i + j + half] * sin[k] + im[i + j + half] * cos[k];
          re[i + j + half] = re[i + j] - tr;
          im[i + j + half] = im[i + j] - ti;
          re[i + j] += tr;
          im[i + j] += ti;
        }
      }
    }
  };
}

// ---------- helpers ----------

export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

export function downsample(samples, rate) {
  const f = Math.max(1, Math.round(rate / TARGET_RATE));
  if (f === 1) return { data: samples, rate };
  const out = new Float32Array(Math.floor(samples.length / f));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let j = 0; j < f; j++) s += samples[i * f + j];
    out[i] = s / f;
  }
  return { data: out, rate: rate / f };
}

export function movingMean(arr, radius) {
  const out = new Float32Array(arr.length);
  let sum = 0, lo = 0, hi = -1;
  for (let i = 0; i < arr.length; i++) {
    while (hi < Math.min(arr.length - 1, i + radius)) sum += arr[++hi];
    while (lo < i - radius) sum -= arr[lo++];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

export function percentile(arr, p) {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] || 0;
}

// ---------- 1. spectral flux ----------

export function spectralFlux(samples, rate, onProgress) {
  const { data, rate: sr } = downsample(samples, rate);
  const frames = Math.max(0, Math.floor((data.length - N) / HOP));
  const fft = makeFFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  const binHz = sr / N;
  const lowMax = Math.round(160 / binHz);          // kick / bass
  const highMin = Math.round(2000 / binHz);        // snare crack, hats, claps
  const highMax = Math.min(N / 2, Math.round(9000 / binHz));

  const all = new Float32Array(frames);
  const energy = new Float32Array(frames); // linear-magnitude flux: loud hits dominate
  const low = new Float32Array(frames);
  const high = new Float32Array(frames);
  const centroid = new Float32Array(frames);
  const level = new Float32Array(frames); // RMS loudness of each frame

  const re = new Float64Array(N), im = new Float64Array(N);
  let prev = new Float64Array(N / 2), cur = new Float64Array(N / 2);
  // Band balance uses linear magnitudes: log compression flattens the big low-end
  // energy of a kick drum, which makes kicks and snares look alike.
  let prevLin = new Float64Array(N / 2), curLin = new Float64Array(N / 2);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let sq = 0;
    for (let i = 0; i < N; i++) { const x = data[off + i]; sq += x * x; re[i] = x * win[i]; im[i] = 0; }
    level[f] = Math.sqrt(sq / N);
    fft(re, im);
    let fa = 0, fl = 0, fh = 0, flin = 0, cw = 0;
    for (let k = 1; k < N / 2; k++) {
      const lin = Math.hypot(re[k], im[k]);
      const mag = Math.log1p(100 * lin);
      cur[k] = mag;
      curLin[k] = lin;
      const d = mag - prev[k];
      if (d > 0) { fa += d; cw += d * k; }
      const dl = lin - prevLin[k];
      if (dl > 0) {
        flin += dl;
        if (k <= lowMax) fl += dl;
        else if (k >= highMin && k <= highMax) fh += dl;
      }
    }
    all[f] = fa;
    energy[f] = Math.sqrt(flin);
    low[f] = flin > 0 ? fl / flin : 0;
    high[f] = flin > 0 ? fh / flin : 0;
    centroid[f] = fa > 0 ? (cw / fa) * binHz : 0;
    [prev, cur] = [cur, prev];
    [prevLin, curLin] = [curLin, prevLin];
    if (onProgress && f % 2000 === 0) onProgress(0.6 * (f / frames));
  }
  const hopSec = HOP / sr;
  // Time of flux frame 0. Frame f compares windows f-1 and f; a hit's flux peaks a little
  // after it reaches the window middle. The +11 ms was measured on synthetic drum hits.
  const t0 = (N / 2) / sr + 0.011;
  return { all, energy, low, high, centroid, level, hopSec, t0, frames, duration: samples.length / rate };
}

// ---------- 2. tempo + beat phase ----------

export function estimateTempo(flux) {
  const { all, hopSec, t0 } = flux;
  // Novelty: flux above its local average
  const mean = movingMean(all, Math.round(0.25 / hopSec));
  const nov = new Float32Array(all.length);
  for (let i = 0; i < all.length; i++) nov[i] = Math.max(0, all[i] - mean[i]);

  // Autocorrelation over 60–200 BPM, weighted toward ~120 BPM (log-normal, 1 octave)
  const minLag = Math.floor(60 / 200 / hopSec), maxLag = Math.ceil(60 / 60 / hopSec);
  let bestLag = minLag, bestScore = -Infinity;
  const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < nov.length; i++) s += nov[i] * nov[i - lag];
    s /= nov.length - lag;
    const bpm = 60 / (lag * hopSec);
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
    scores[lag] = s * w;
    if (scores[lag] > bestScore) { bestScore = scores[lag]; bestLag = lag; }
  }
  // Parabolic refinement
  const a = scores[bestLag - 1] || 0, b = scores[bestLag], c = scores[bestLag + 1] || 0;
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  let bpm = 60 / ((bestLag + Math.max(-0.5, Math.min(0.5, shift))) * hopSec);

  // Fine search: which BPM + phase lines a beat grid up with the most energy?
  // Bass-heavy hits (kicks, bass notes) count extra: they usually land on the beat,
  // which keeps the grid from locking onto off-beat hi-hats or melodies.
  const beatNov = new Float32Array(nov.length);
  for (let i = 0; i < nov.length; i++) beatNov[i] = nov[i] * (0.25 + flux.low[i]);
  const at = (t) => {
    const x = (t - t0) / hopSec;
    const i = Math.floor(x);
    if (i < 0 || i + 1 >= beatNov.length) return 0;
    return beatNov[i] + (beatNov[i + 1] - beatNov[i]) * (x - i);
  };
  const dur = flux.duration;
  let best = { bpm, phase: 0, score: -Infinity };
  for (let k = -40; k <= 40; k++) {
    const cand = bpm * (1 + k * 0.0008);
    const beat = 60 / cand;
    for (let p = 0; p < 48; p++) {
      const phase = (p / 48) * beat;
      let s = 0;
      for (let t = phase; t < dur; t += beat) s += at(t) + 0.5 * at(t + beat / 2);
      if (s > best.score) best = { bpm: cand, phase, score: s };
    }
  }
  // Refine phase finer around the best
  const beat = 60 / best.bpm;
  for (let p = -12; p <= 12; p++) {
    const phase = best.phase + (p / 12) * (beat / 48);
    let s = 0;
    for (let t = phase; t < dur; t += beat) s += at(t) + 0.5 * at(t + beat / 2);
    if (s > best.score) best = { ...best, phase, score: s };
  }

  let finalBpm = best.bpm;
  while (finalBpm < 75) finalBpm *= 2;
  while (finalBpm > 190) finalBpm /= 2;
  const fb = 60 / finalBpm;
  return { bpm: finalBpm, offset: ((best.phase % fb) + fb) % fb, novelty: nov };
}

// ---------- 3. beat tracking ----------

/**
 * Dynamic-programming beat tracker (Ellis 2007). Finds the sequence of beats that best
 * lines up with strong onsets while keeping intervals close to the estimated tempo,
 * so it follows small tempo drift instead of assuming a perfectly fixed grid.
 */
export function trackBeats(flux, bpm) {
  const { hopSec, t0, energy, low } = flux;
  // Beat envelope from linear-magnitude flux (loud kicks and snares dominate, quiet but
  // sharp hi-hats don't), with extra weight on bass-heavy hits.
  const mean = movingMean(energy, Math.round(0.25 / hopSec));
  const env = new Float64Array(energy.length);
  let sq = 0;
  for (let i = 0; i < energy.length; i++) {
    env[i] = Math.max(0, energy[i] - mean[i]) * (0.5 + low[i]);
    sq += env[i] * env[i];
  }
  const std = Math.sqrt(sq / Math.max(1, env.length)) || 1;
  for (let i = 0; i < env.length; i++) env[i] /= std;

  const P = 60 / bpm / hopSec;           // beat period in frames
  const tight = 100;                      // how strongly to keep the tempo steady
  const n = env.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(P / 2), hi = Math.round(2 * P);
  for (let t = 0; t < n; t++) {
    let best = -Infinity, arg = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const pen = Math.log((t - tau) / P);
      const v = score[tau] - tight * pen * pen;
      if (v > best) { best = v; arg = tau; }
    }
    if (arg >= 0 && best > 0) { score[t] = env[t] + best; back[t] = arg; }
    else score[t] = env[t];
  }
  // Best final beat within the last period, then walk backwards
  let end = n - 1;
  for (let t = Math.max(0, n - Math.ceil(P)); t < n; t++) if (score[t] > score[end]) end = t;
  const frames = [];
  for (let t = end; t >= 0; t = back[t]) frames.push(t);
  frames.reverse();
  const raw = frames.map((f) => t0 + f * hopSec);

  // Beat times are quantized to ~12 ms frames. Smooth the jitter with a local straight-line
  // fit over ±4 beats: keeps slow tempo drift, removes frame-rounding wobble.
  const W = 4;
  return raw.map((_, i) => {
    let n2 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = Math.max(0, i - W); j <= Math.min(raw.length - 1, i + W); j++) {
      n2++; sx += j; sy += raw[j]; sxx += j * j; sxy += j * raw[j];
    }
    const slope = (n2 * sxy - sx * sy) / (n2 * sxx - sx * sx || 1);
    const icpt = (sy - slope * sx) / n2;
    return n2 > 2 ? icpt + slope * i : raw[i];
  });
}

// ---------- 4. notes ----------

const DIFFS = {
  //          allowed subdivisions (0 = on the beat, 2 = 8th, 1/3 = 16ths), notes per beat,
  //          min gap in beats, weights for 8ths / 16ths, big notes allowed
  easy:   { subs: [0],          perBeat: 0.38, gap: 1.75, w8: 0,    w16: 0,   big: false },
  medium: { subs: [0, 2],       perBeat: 0.65, gap: 0.9,  w8: 0.45, w16: 0,   big: true },
  hard:   { subs: [0, 2],       perBeat: 1.0,  gap: 0.5,  w8: 0.7,  w16: 0,   big: true },
  expert: { subs: [0, 1, 2, 3], perBeat: 1.45, gap: 0.25, w8: 0.8,  w16: 0.5, big: true },
};

/** Every 16th-note position between tracked beats, with how strong the sound is there. */
export function gridSlots(flux, beats) {
  const { all, energy, low, high, centroid, hopSec, t0 } = flux;
  // How hard each moment hits: mostly loudness (linear flux), plus some sharpness (log flux)
  // so crisp-but-quiet sounds still count a little.
  const mE = movingMean(energy, Math.round(0.25 / hopSec));
  const mA = movingMean(all, Math.round(0.25 / hopSec));
  const nE = new Float32Array(all.length), nA = new Float32Array(all.length);
  for (let i = 0; i < all.length; i++) { nE[i] = Math.max(0, energy[i] - mE[i]); nA[i] = Math.max(0, all[i] - mA[i]); }
  const pE = percentile(nE, 0.95) || 1, pA = percentile(nA, 0.95) || 1;
  const nov = new Float32Array(all.length);
  for (let i = 0; i < all.length; i++) nov[i] = 0.75 * nE[i] / pE + 0.25 * nA[i] / pA;
  const p95 = percentile(nov, 0.95) || 1;
  const frameOf = (t) => Math.round((t - t0) / hopSec);
  const slots = [];
  for (let b = 0; b < beats.length - 1; b++) {
    const step = (beats[b + 1] - beats[b]) / 4;
    for (let k = 0; k < 4; k++) {
      const time = beats[b] + k * step;
      const f = frameOf(time);
      // strongest frame within ±25 ms of the grid point
      let best = -1, bi = f;
      const r = Math.max(1, Math.round(0.025 / hopSec));
      for (let j = f - r; j <= f + r; j++) if (j >= 0 && j < nov.length && nov[j] > best) { best = nov[j]; bi = j; }
      if (best < 0) continue;
      slots.push({
        time, beat: b, sub: k,
        strength: Math.min(2, best / p95),
        low: Math.max(low[bi] || 0, low[bi + 1] || 0),
        high: Math.max(high[bi] || 0, high[bi + 1] || 0),
        centroid: centroid[bi] || 0,
      });
    }
  }
  return slots;
}

export function pickNotes(slots, cfg, beatLen, activeBeats) {
  const weight = (s) => (s.sub === 0 ? 1 : s.sub === 2 ? cfg.w8 : cfg.w16);
  const quota = Math.round(activeBeats * cfg.perBeat);
  const cands = slots
    .filter((s) => cfg.subs.includes(s.sub) && s.strength >= 0.22 && weight(s) > 0)
    .sort((a, b) => b.strength * weight(b) - a.strength * weight(a));
  const chosen = [];
  const minGap = cfg.gap * beatLen * 0.97;
  const taken = []; // sorted times
  const near = (t) => {
    // binary search for neighbours
    let lo = 0, hi = taken.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (taken[m] < t) lo = m + 1; else hi = m; }
    return (lo < taken.length && taken[lo] - t < minGap) || (lo > 0 && t - taken[lo - 1] < minGap);
  };
  for (const s of cands) {
    if (chosen.length >= quota) break;
    if (near(s.time)) continue;
    chosen.push(s);
    let i = taken.length;
    taken.push(s.time);
    while (i > 0 && taken[i - 1] > s.time) { taken[i] = taken[i - 1]; i--; }
    taken[i] = s.time;
  }
  return chosen.sort((a, b) => a.time - b.time);
}

export function buildCharts(flux, beats) {
  const beatLen = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.5;
  const slots = gridSlots(flux, beats);

  // Bar phase: which of every 4 beats carries the most bass → treat as beat 1 of the bar
  const barScore = [0, 0, 0, 0];
  for (const s of slots) if (s.sub === 0) barScore[s.beat % 4] += s.strength * s.low;
  const barPhase = barScore.indexOf(Math.max(...barScore));

  // Beats where the song is actually playing (skip silent intros/outros for quotas)
  const activeBeats = new Set(slots.filter((s) => s.strength > 0.15).map((s) => s.beat)).size;

  // don vs ka: split all candidate hits into two groups by low/high balance (1-D k-means)
  const ratio = (n) => Math.log((n.low + 1e-3) / (n.high + 1e-3));
  const rs = slots.filter((s) => s.strength > 0.3).map(ratio).sort((a, b) => a - b);
  let cLo = rs[Math.floor(rs.length * 0.25)] ?? 0, cHi = rs[Math.floor(rs.length * 0.75)] ?? 0;
  for (let it = 0; it < 20; it++) {
    const mid = (cLo + cHi) / 2;
    const a = rs.filter((r) => r < mid), b = rs.filter((r) => r >= mid);
    if (!a.length || !b.length) break;
    cLo = a.reduce((x, y) => x + y, 0) / a.length;
    cHi = b.reduce((x, y) => x + y, 0) / b.length;
  }
  const split = (cLo + cHi) / 2;
  const isDon = (n) => ratio(n) >= split;

  const drum = {}, highway = {};
  for (const [name, cfg] of Object.entries(DIFFS)) {
    const notes = pickNotes(slots, cfg, beatLen, activeBeats);
    const strengths = notes.map((n) => n.strength).sort((a, b) => a - b);
    const bigCut = cfg.big ? strengths[Math.floor(strengths.length * 0.95)] ?? Infinity : Infinity;
    const isBig = (n) => n.sub === 0 && (n.beat - barPhase) % 4 === 0 && n.strength >= bigCut;

    drum[name] = notes.map((n) => {
      const kind = isDon(n) ? 'don' : 'ka';
      return { time: round3(n.time), type: isBig(n) ? (kind === 'don' ? 'bigDon' : 'bigKa') : kind };
    });

    // Highway: lane by brightness (centroid quantiles); easy uses the middle three lanes
    const cents = notes.map((n) => n.centroid).sort((a, b) => a - b);
    const lanes = name === 'easy' ? 3 : 5;
    const q = Array.from({ length: lanes - 1 }, (_, i) => cents[Math.floor(((i + 1) / lanes) * cents.length)] ?? 0);
    const laneOf = (c) => q.filter((x) => c > x).length + (lanes === 3 ? 1 : 0);
    const hw = [];
    for (const n of notes) {
      const lane = laneOf(n.centroid);
      hw.push({ time: round3(n.time), lane, duration: 0 });
      if (isBig(n) && name !== 'easy') hw.push({ time: round3(n.time), lane: lane <= 2 ? lane + 2 : lane - 2, duration: 0 });
    }
    highway[name] = hw;
  }
  return { bpm: 60 / beatLen, beats, barPhase, drum, highway };
}

export const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Mix analysis shared by every chart of a song: flux, tempo, beat grid, and the
 * full-song charts. Progress goes 0 → 1 over this step.
 */
export function analyzeMix(mono, sampleRate, onProgress = () => {}) {
  const flux = spectralFlux(mono, sampleRate, onProgress);
  onProgress(0.65);
  const tempo = estimateTempo(flux);
  onProgress(0.75);
  const beats = trackBeats(flux, tempo.bpm);
  onProgress(0.9);
  const charts = buildCharts(flux, beats);
  onProgress(1);
  return { flux, beats, charts };
}

/** Chart JSON for the full mix, from analyzeMix's result. */
export function mixChartJSON(charts, meta = {}) {
  const first = charts.beats[charts.barPhase] ?? 0;
  const bar = (60 / charts.bpm) * 4;
  return {
    version: CHART_VERSION,
    title: meta.title || 'Untitled',
    artist: meta.artist || 'Auto-charted',
    bpm: Math.round(charts.bpm * 100) / 100,
    offset: round3(((first % bar) + bar) % bar),
    beats: charts.beats.map(round3),
    barPhase: charts.barPhase,
    difficulties: charts.highway,
    drum: charts.drum,
  };
}

/** Full pipeline: samples → chart JSON (before normalizeChart). */
export function autoChart(channels, sampleRate, meta = {}, onProgress = () => {}) {
  const { charts } = analyzeMix(mixToMono(channels), sampleRate, onProgress);
  return mixChartJSON(charts, meta);
}
