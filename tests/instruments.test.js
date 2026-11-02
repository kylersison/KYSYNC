import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yin, predominantPitch, lanesFromPitch, hzToMidi, midiToHz } from '../src/pitch.js';
import { autoChartSong, vocalNotes } from '../src/instrumentChart.js';
import { normalizeChart } from '../src/chart.js';

const RATE = 22050;

function tone(freq, seconds, rate = RATE, harmonics = 1) {
  const out = new Float32Array(Math.floor(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let h = 1; h <= harmonics; h++) s += Math.sin((2 * Math.PI * freq * h * i) / rate) / h;
    out[i] = s * 0.5;
  }
  return out;
}

test('yin finds a bass note', () => {
  const x = tone(110, 0.5);
  const r = yin(x, RATE, 1000, 2048, 30, 400);
  assert.ok(Math.abs(r.midi - hzToMidi(110)) < 0.2, `midi ${r.midi}`);
  assert.ok(r.clarity > 0.8);
});

test('predominantPitch picks the fundamental of a rich tone, not an octave', () => {
  for (const midi of [52, 60, 67, 76]) {
    const x = tone(midiToHz(midi), 0.4, RATE, 6);
    const r = predominantPitch(x, RATE, 500, { size: 4096 });
    assert.equal(r.midi, midi);
  }
});

test('lanes follow the pitch contour', () => {
  const pitches = [60, 62, 64, 65, 67, 67, 65, 64, 62, 60, 72, 48];
  const times = pitches.map((_, i) => i * 0.25);
  const lanes = lanesFromPitch(times, pitches, { lanes: 5, window: 2 });
  for (let i = 1; i < pitches.length; i++) {
    const dp = Math.sign(pitches[i] - pitches[i - 1]);
    const dl = Math.sign(lanes[i] - lanes[i - 1]);
    if (dp === 0) assert.equal(dl, 0, `repeat at ${i}`);
    else if (dl !== 0) assert.equal(dl, dp, `direction at ${i}: ${lanes}`);
  }
  assert.ok(lanes.every((l) => l >= 0 && l <= 4));
  assert.ok(new Set(lanes).size >= 4, `uses the highway: ${lanes}`);
});

/** A short synthetic band: drums, a bass line on the beat, a sung melody of half notes. */
function band({ bpm = 120, bars = 24, rate = RATE }) {
  const beat = 60 / bpm;
  const seconds = (bars * 4 + 2) * beat;
  const n = Math.floor(seconds * rate);
  const drums = new Float32Array(n), bass = new Float32Array(n), vocals = new Float32Array(n);
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (buf, t, len, fn) => {
    const s0 = Math.floor(t * rate);
    for (let i = 0; i < len * rate && s0 + i < n; i++) buf[s0 + i] += fn(i / rate);
  };
  const bassLine = [36, 40, 43, 45]; // C2 E2 G2 A2, one per beat
  const melody = [64, 67, 69, 67, 64, 62, 60, 62]; // half notes
  const sung = [];
  for (let b = 0; b < bars * 4; b++) {
    const t = beat + b * beat;
    if (b % 2 === 0) add(drums, t, 0.3, (x) => 0.9 * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-x * 30)) * x) * Math.exp(-x * 9));
    else add(drums, t, 0.2, (x) => rand() * 0.6 * Math.exp(-x * 25));
    const f = midiToHz(bassLine[b % 4]);
    add(bass, t, beat * 0.95, (x) => 0.5 * Math.sin(2 * Math.PI * f * x) * Math.min(1, x * 200) * Math.exp(-x * 1.5));
    if (b % 2 === 0) {
      const m = melody[(b / 2) % melody.length];
      const fv = midiToHz(m);
      sung.push({ time: t, midi: m });
      // ±60 cents of vibrato at 5.5 Hz, like a real singer: must not split the note
      const dev = (fv * (2 ** (0.6 / 12) - 1)) / 5.5;
      add(vocals, t, beat * 1.8, (x) => {
        const ph = 2 * Math.PI * fv * x + dev * Math.sin(2 * Math.PI * 5.5 * x) * Math.min(1, x * 3);
        return 0.3 * Math.min(1, x * 40) * Math.min(1, (beat * 1.8 - x) * 40) *
          (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph));
      });
    }
  }
  return { stems: { drums, bass, vocals }, beat, sung };
}

test('vocal notes come out as one note per sung note, with the right pitch', () => {
  const { stems, beat, sung } = band({});
  const beats = Array.from({ length: 24 * 4 + 2 }, (_, i) => i * beat);
  const notes = vocalNotes(stems.vocals, RATE, beats, 0.3);
  assert.ok(Math.abs(notes.length - sung.length) <= 2, `${notes.length} vs ${sung.length}`);
  let right = 0;
  for (const s of sung) {
    const n = notes.find((x) => Math.abs(x.time - s.time) < 0.07);
    if (n && Math.abs(n.pitch - s.midi) < 0.6) right++;
  }
  assert.ok(right >= sung.length - 2, `${right}/${sung.length} matched`);
});

test('a song with stems gets drums, bass and vocal charts on the shared beat grid', () => {
  const { stems, beat, sung } = band({});
  const raw = autoChartSong({ mix: null, stems, rate: RATE, meta: { title: 'Band' } });
  assert.ok(Math.abs(raw.bpm - 120) < 1, `bpm ${raw.bpm}`);
  assert.deepEqual(Object.keys(raw.instruments).sort(), ['bass', 'drums', 'vocals']);

  const chart = normalizeChart(raw);
  const bass = chart.instruments.bass.difficulties.expert;
  // bass notes land on beats, and C→E→G→A climbs to the right
  const onBeat = bass.filter((n) => { const f = (n.time / beat) % 1; return Math.min(f, 1 - f) < 0.06; });
  assert.ok(onBeat.length / bass.length > 0.9, `${onBeat.length}/${bass.length} on the beat`);
  let climbs = 0, steps = 0;
  for (let i = 1; i < bass.length; i++) {
    // the line starts one beat in: beat k plays bassLine[(k - 1) % 4]
    const a = (Math.round(bass[i - 1].time / beat) + 3) % 4, b = (Math.round(bass[i].time / beat) + 3) % 4;
    if (b === a + 1) { steps++; if (bass[i].lane > bass[i - 1].lane) climbs++; }
  }
  assert.ok(steps > 20 && climbs / steps > 0.85, `${climbs}/${steps} upward steps go right`);

  // vocals: long notes become holds
  const vox = chart.instruments.vocals.difficulties.expert;
  assert.ok(Math.abs(vox.length - sung.length) <= 3, `${vox.length} vocal notes`);
  assert.ok(vox.filter((n) => n.duration > beat).length > vox.length * 0.7, 'mostly holds');

  // every instrument has all four difficulties for both modes
  for (const inst of Object.values(chart.instruments)) {
    for (const d of ['easy', 'medium', 'hard', 'expert']) {
      assert.ok(inst.difficulties[d].length > 0, d);
      assert.ok(inst.drum[d].length > 0, `drum ${d}`);
    }
  }
});
