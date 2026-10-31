import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoChart } from '../src/analysis.js';
import { normalizeChart } from '../src/chart.js';

// Synthesize a drum loop: kick on every beat, snare on 2 and 4, closed hats on 8ths.
function drumLoop({ bpm, offset, seconds, rate = 44100 }) {
  const out = new Float32Array(Math.floor(seconds * rate));
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (t, fn, len) => {
    const s0 = Math.floor(t * rate);
    for (let i = 0; i < len * rate && s0 + i < out.length; i++) out[s0 + i] += fn(i / rate);
  };
  const beat = 60 / bpm;
  const kicks = [], snares = [];
  for (let b = 0; offset + b * beat < seconds - 0.5; b++) {
    const t = offset + b * beat;
    if (b % 2 === 1) {
      snares.push(t);
      add(t, (x) => rand() * 0.6 * Math.exp(-x * 25) + 0.2 * Math.sin(2 * Math.PI * 190 * x) * Math.exp(-x * 30), 0.2);
    } else {
      kicks.push(t);
      add(t, (x) => 0.9 * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-x * 30)) * x) * Math.exp(-x * 9), 0.35);
    }
    for (const h of [0, 0.5]) add(t + h * beat, (x) => rand() * 0.12 * Math.exp(-x * 120), 0.04);
  }
  return { samples: out, kicks, snares, rate };
}

test('auto-chart finds tempo, beat phase and don/ka', () => {
  const bpm = 124, offset = 0.37;
  const { samples, kicks, snares, rate } = drumLoop({ bpm, offset, seconds: 40 });
  const raw = autoChart([samples], rate, { title: 'Loop' });

  assert.ok(Math.abs(raw.bpm - bpm) < 0.5, `bpm ${raw.bpm}`);
  const beat = 60 / bpm;
  const phaseErr = Math.abs(((raw.offset - offset + beat / 2) % beat + beat) % beat - beat / 2);
  assert.ok(phaseErr < 0.015, `offset ${raw.offset} (err ${phaseErr})`);

  const chart = normalizeChart(raw);
  const drum = chart.drum.expert;
  const near = (list, t) => list.some((x) => Math.abs(x - t) < 0.03);
  const kickNotes = drum.filter((n) => near(kicks, n.time));
  const snareNotes = drum.filter((n) => near(snares, n.time));
  assert.ok(kickNotes.length > kicks.length * 0.8, `kicks found ${kickNotes.length}/${kicks.length}`);
  assert.ok(snareNotes.length > snares.length * 0.8, `snares found ${snareNotes.length}/${snares.length}`);
  const donRate = kickNotes.filter((n) => n.type.toLowerCase().includes('don')).length / kickNotes.length;
  const kaRate = snareNotes.filter((n) => n.type.toLowerCase().includes('ka')).length / snareNotes.length;
  assert.ok(donRate > 0.9, `kicks as don: ${donRate}`);
  assert.ok(kaRate > 0.9, `snares as ka: ${kaRate}`);

  // timing accuracy of placed notes vs. true hits
  const errs = [...kickNotes, ...snareNotes].map((n) =>
    Math.min(...[...kicks, ...snares].map((x) => Math.abs(x - n.time))));
  const meanErr = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(meanErr < 0.01, `mean timing error ${(meanErr * 1000).toFixed(1)} ms`);

  // every difficulty has notes
  for (const d of ['easy', 'medium', 'hard', 'expert']) {
    assert.ok(chart.drum[d].length > 10, `drum ${d}`);
    assert.ok(chart.difficulties[d].length > 10, `highway ${d}`);
  }
});

// A harder song: tempo drifts 116 → 128 BPM, loud off-beat hats, syncopated bass synth.
function driftingSong({ seconds = 50, rate = 44100 } = {}) {
  const out = new Float32Array(Math.floor(seconds * rate));
  let seed = 19;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (t, fn, len) => {
    const s0 = Math.floor(t * rate);
    for (let i = 0; i < len * rate && s0 + i < out.length; i++) out[s0 + i] += fn(i / rate);
  };
  const beats = [];
  let t = 0.8, b = 0;
  while (t < seconds - 1) {
    const bpm = 116 + 12 * (t / seconds);
    const beat = 60 / bpm;
    beats.push(t);
    if (b % 2 === 0) add(t, (x) => 0.9 * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-x * 30)) * x) * Math.exp(-x * 9), 0.35);
    else add(t, (x) => rand() * 0.5 * Math.exp(-x * 22), 0.2);
    add(t + beat / 2, (x) => rand() * 0.35 * Math.exp(-x * 60), 0.06); // loud off-beat hat
    add(t + beat * 0.75, (x) => 0.3 * Math.sign(Math.sin(2 * Math.PI * 110 * x)) * Math.exp(-x * 12), 0.15); // syncopated synth
    t += beat; b++;
  }
  return { samples: out, beats, rate };
}

test('beat tracker follows tempo drift; easy notes sit on the beat', () => {
  const { samples, beats, rate } = driftingSong();
  const raw = autoChart([samples], rate, {});
  const nearest = (list, x) => list.reduce((m, y) => Math.min(m, Math.abs(y - x)), Infinity);

  const tracked = raw.beats.filter((b) => b > 1.5 && b < 48);
  const onBeat = tracked.filter((b) => nearest(beats, b) < 0.025).length / tracked.length;
  assert.ok(onBeat > 0.9, `tracked beats on true beats: ${onBeat}`);

  const chart = normalizeChart(raw);
  for (const d of ['easy', 'medium']) {
    const notes = chart.drum[d];
    const ok = notes.filter((n) => nearest(beats, n.time) < 0.03).length / notes.length;
    assert.ok(ok > 0.9, `${d} notes on beats: ${ok}`);
  }
  // Density: easy well under one note per beat, expert the densest
  const perBeat = (d) => chart.drum[d].length / beats.length;
  assert.ok(perBeat('easy') < 0.5, `easy ${perBeat('easy')}`);
  assert.ok(perBeat('easy') < perBeat('medium') && perBeat('medium') < perBeat('hard') && perBeat('hard') < perBeat('expert'));
});
