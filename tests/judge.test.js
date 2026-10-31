import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Judge, gradeFor } from '../src/judge.js';
import { normalizeChart, deriveDifficulties } from '../src/chart.js';
import { buildDemoChart } from '../src/demoSong.js';

test('grade windows', () => {
  assert.equal(gradeFor(0.01), 'perfect');
  assert.equal(gradeFor(0.06), 'great');
  assert.equal(gradeFor(0.1), 'good');
  assert.equal(gradeFor(0.2), null);
});

test('hit, ghost tap, and auto-miss', () => {
  const j = new Judge([
    { time: 1, lane: 0 },
    { time: 2, lane: 0 },
    { time: 3, lane: 1 },
  ]);
  assert.equal(j.press(0, 0.5), null, 'way-early press is a ghost tap');
  assert.equal(j.press(0, 1.02).result, 'perfect');
  assert.equal(j.combo, 1);
  j.update(2.5); // lane-0 note at t=2 passes unhit
  assert.equal(j.counts.miss, 1);
  assert.equal(j.combo, 0);
  assert.equal(j.press(1, 2.95).result, 'great');
  assert.ok(j.isFinished());
});

test('hold notes score sustain and can be broken', () => {
  const j = new Judge([
    { time: 1, lane: 2, duration: 1 },
    { time: 3, lane: 2, duration: 1 },
  ]);
  j.press(2, 1);
  j.update(1.5);
  const mid = j.score;
  j.update(2.0);
  assert.ok(j.score > mid, 'sustain adds score while held');
  assert.equal(j.notes[0].holdState, 'done');

  j.press(2, 3);
  j.release(2, 3.3);
  assert.equal(j.notes[1].holdState, 'broken');
  assert.equal(j.combo, 2, 'breaking a hold does not break combo');
});

test('releasing just before the end counts as a full hold', () => {
  const j = new Judge([{ time: 1, lane: 0, duration: 1 }]);
  j.press(0, 1);
  j.release(0, 1.95);
  assert.equal(j.notes[0].holdState, 'done');
});

test('multiplier climbs every 10 combo and caps at 4', () => {
  const notes = Array.from({ length: 50 }, (_, i) => ({ time: i * 0.5, lane: i % 5 }));
  const j = new Judge(notes);
  for (const n of notes) j.press(n.lane, n.time);
  assert.equal(j.combo, 50);
  assert.equal(j.multiplier, 4);
});

test('demo chart is valid and difficulties get easier', () => {
  const chart = normalizeChart(buildDemoChart());
  const counts = ['easy', 'medium', 'hard', 'expert'].map((d) => chart.difficulties[d].length);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1], `${counts}`);
  assert.ok(chart.difficulties.easy.every((n) => n.lane <= 2), 'easy uses 3 lanes');
  for (const notes of Object.values(chart.difficulties)) {
    for (let i = 1; i < notes.length; i++) assert.ok(notes[i].time >= notes[i - 1].time);
  }
});

test('short-form chart derives all difficulties', () => {
  const chart = normalizeChart({ bpm: 120, notes: [{ time: 0, lane: 4 }, { time: 0.5, lane: 3 }] });
  assert.deepEqual(Object.keys(chart.difficulties), ['easy', 'medium', 'hard', 'expert']);
  assert.equal(deriveDifficulties(chart.difficulties.expert, 120).easy[0].lane, 2);
});
