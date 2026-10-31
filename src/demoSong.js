// Built-in demo song, so the game is playable with zero audio files.
// The chart is generated first, then the audio is synthesized FROM the chart,
// so every note you hit is a sound you actually hear (lane = pitch, low → high).

const BPM = 128;
const BEAT = 60 / BPM;
const EIGHTH = BEAT / 2;
const BAR = BEAT * 4;
const COUNT_IN_BARS = 2;
const PLAY_BARS = 32;
const OUTRO_BARS = 2;
const OFFSET = 0; // beat 1 of bar 1 is at t = 0

// C major pentatonic: one pitch per lane.
const LEAD_FREQS = [261.63, 293.66, 329.63, 392.0, 440.0];
// Bass roots per bar: C, A, F, G
const BASS_FREQS = [65.41, 55.0, 43.65, 49.0];

// Rhythm templates in eighth notes within a bar (0–7). l = hold length in eighths.
const T = (...items) => items.map((x) => (typeof x === 'number' ? { s: x, l: 0 } : { l: 0, ...x }));
const TEMPLATES = {
  simple: [T(0, 2, 4, 6), T(0, 2, 4, 5, 6), T(0, 1, 2, 4, 6), T(0, 2, 4, 6, 7)],
  holds: [
    T({ s: 0, l: 3 }, 4, 6),
    T(0, 2, { s: 4, l: 3 }),
    T({ s: 0, l: 2 }, { s: 2, l: 2 }, 4, 5, 6),
    T(0, 1, { s: 2, l: 4 }, 7),
  ],
  busy: [T(0, 1, 2, 3, 4, 6, 7), T(0, 1, 2, 4, 5, 6), T(0, 2, 3, 4, 5, 6, 7), T(0, 1, 2, 3, 4, 5, 6)],
};

function rng(seed) {
  // mulberry32
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sectionFor(bar) {
  if (bar < 8) return 'simple';
  if (bar < 16) return 'holds';
  if (bar < 24) return 'busy';
  return bar % 2 ? 'busy' : 'holds';
}

export function buildDemoChart() {
  const rand = rng(1337);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const notes = [];
  let lane = 2;

  for (let bar = 0; bar < PLAY_BARS; bar++) {
    const barStart = OFFSET + (COUNT_IN_BARS + bar) * BAR;
    const isLast = bar === PLAY_BARS - 1;
    const section = sectionFor(bar);
    const template = isLast ? T({ s: 0, l: 6 }) : pick(TEMPLATES[section]);

    for (const { s, l } of template) {
      lane = Math.max(0, Math.min(4, lane + pick([-2, -1, -1, 0, 1, 1, 2])));
      const time = barStart + s * EIGHTH;
      const duration = l ? l * EIGHTH - EIGHTH * 0.25 : 0;
      notes.push({ time, lane, duration });

      // Chords on downbeats in the busy sections and the final note.
      const chord = (section === 'busy' && bar >= 16 && (s === 0 || s === 4)) || isLast;
      if (chord) {
        const other = lane <= 2 ? lane + 2 : lane - 2;
        notes.push({ time, lane: other, duration });
      }
    }
  }

  notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
  return {
    title: 'Pentatonic Rush',
    artist: 'KySync Demo',
    bpm: BPM,
    offset: OFFSET,
    notes,
  };
}

export const DEMO_LENGTH = (COUNT_IN_BARS + PLAY_BARS + OUTRO_BARS) * BAR;

// ---------- Audio synthesis (browser only: needs OfflineAudioContext) ----------

function noiseBuffer(ctx, seconds = 1) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buf.getChannelData(0);
  const r = rng(7);
  for (let i = 0; i < data.length; i++) data[i] = r() * 2 - 1;
  return buf;
}

function kick(ctx, out, t) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  g.gain.setValueAtTime(0.9, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  o.connect(g).connect(out);
  o.start(t); o.stop(t + 0.32);
}

function snare(ctx, out, t, noise) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  src.connect(bp).connect(g).connect(out);
  src.start(t, Math.random() * 0.5); src.stop(t + 0.2);
}

function hat(ctx, out, t, noise, open = false) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 7000;
  const g = ctx.createGain();
  const len = open ? 0.12 : 0.04;
  g.gain.setValueAtTime(0.16, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  src.connect(hp).connect(g).connect(out);
  src.start(t, Math.random() * 0.5); src.stop(t + len + 0.01);
}

function bass(ctx, out, t, freq, len) {
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.35, t + 0.01);
  g.gain.setValueAtTime(0.35, t + len - 0.05);
  g.gain.linearRampToValueAtTime(0, t + len);
  o.connect(g).connect(out);
  o.start(t); o.stop(t + len + 0.01);
}

function lead(ctx, out, t, freq, len) {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(3200, t);
  f.frequency.exponentialRampToValueAtTime(1400, t + Math.max(0.08, len));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.13, t + 0.006);
  g.gain.linearRampToValueAtTime(0.09, t + 0.08);
  g.gain.setValueAtTime(0.09, t + len);
  g.gain.linearRampToValueAtTime(0, t + len + 0.08);
  f.connect(g).connect(out);
  for (const detune of [-7, 7]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    o.detune.value = detune;
    o.connect(f);
    o.start(t); o.stop(t + len + 0.1);
  }
}

/** Render the demo song to an AudioBuffer that plays exactly like an uploaded file. */
export async function renderDemoAudio(chart, sampleRate = 44100) {
  const ctx = new OfflineAudioContext(2, Math.ceil(DEMO_LENGTH * sampleRate), sampleRate);
  const comp = ctx.createDynamicsCompressor();
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(comp).connect(ctx.destination);
  const noise = noiseBuffer(ctx);

  const totalBars = COUNT_IN_BARS + PLAY_BARS + OUTRO_BARS;
  for (let bar = 0; bar < totalBars; bar++) {
    const b0 = OFFSET + bar * BAR;
    const playing = bar >= COUNT_IN_BARS && bar < COUNT_IN_BARS + PLAY_BARS;
    for (let e = 0; e < 8; e++) {
      const t = b0 + e * EIGHTH;
      if (bar < totalBars - 1 || e === 0) hat(ctx, master, t, noise, e % 2 === 1 && playing);
      if (e % 2 === 0 && (playing || e === 0 || bar < COUNT_IN_BARS)) kick(ctx, master, t);
      if (playing && (e === 2 || e === 6)) snare(ctx, master, t, noise);
    }
    if (playing) {
      const root = BASS_FREQS[(bar - COUNT_IN_BARS) % 4];
      for (let e = 0; e < 8; e += 2) bass(ctx, master, b0 + e * EIGHTH, root, BEAT * 0.9);
    }
  }

  for (const n of chart.notes) {
    const len = n.duration > 0 ? n.duration : EIGHTH * 0.8;
    lead(ctx, master, n.time, LEAD_FREQS[n.lane], len);
  }

  return ctx.startRendering();
}
