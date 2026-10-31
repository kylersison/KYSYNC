import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DrumJudge } from '../src/drumJudge.js';
import { normalizeChart, drumFromHighway } from '../src/chart.js';
import { buildDemoChart } from '../src/demoSong.js';

const D = 0, F = 1, J = 2, K = 3;

test('don on F/J, ka on D/K', () => {
  const j = new DrumJudge([
    { time: 1, type: 'don' },
    { time: 2, type: 'ka' },
    { time: 3, type: 'don' },
    { time: 4, type: 'ka' },
  ]);
  assert.equal(j.press(F, 1.0).result, 'perfect');
  assert.equal(j.press(K, 2.05).result, 'great');
  assert.equal(j.press(J, 3.0).result, 'perfect');
  assert.equal(j.press(D, 4.0).result, 'perfect');
  assert.equal(j.combo, 4);
  assert.ok(j.isFinished());
});

test('wrong drum inside the window is a miss', () => {
  const j = new DrumJudge([{ time: 1, type: 'don' }, { time: 2, type: 'don' }]);
  assert.equal(j.press(D, 1.0).result, 'miss');
  assert.equal(j.combo, 0);
  assert.equal(j.press(F, 2.0).result, 'perfect');
});

test('early press is a ghost tap, late notes auto-miss', () => {
  const j = new DrumJudge([{ time: 1, type: 'don' }]);
  assert.equal(j.press(F, 0.5), null);
  j.update(1.5);
  assert.equal(j.counts.miss, 1);
});

test('big note: second hand within 50 ms doubles points', () => {
  const a = new DrumJudge([{ time: 1, type: 'bigDon' }]);
  a.press(F, 1.0);
  const single = a.score;
  a.press(J, 1.02);
  assert.equal(a.score, single * 2);
  assert.ok(a.notes[0].bonus);

  const b = new DrumJudge([{ time: 1, type: 'bigDon' }]);
  b.press(F, 1.0);
  b.press(J, 1.2); // too late for the bonus
  assert.ok(!b.notes[0].bonus);
});

test('drumroll counts every hit and never breaks combo', () => {
  const j = new DrumJudge([{ time: 0.5, type: 'don' }, { time: 1, type: 'roll', duration: 1 }]);
  j.press(F, 0.5);
  for (let t = 1.0; t < 2.0; t += 0.1) j.press(t % 0.2 < 0.1 ? F : K, t);
  j.update(2.5);
  assert.equal(j.notes[1].rollHits, 10);
  assert.equal(j.combo, 1);
  assert.ok(j.isFinished());
});

test('highway → drum conversion', () => {
  const drum = drumFromHighway([
    { time: 1, lane: 0, duration: 0 },
    { time: 2, lane: 4, duration: 0 },
    { time: 3, lane: 1, duration: 0 },
    { time: 3, lane: 3, duration: 0 },
    { time: 4, lane: 2, duration: 1 },
  ]);
  assert.deepEqual(drum.map((n) => n.type), ['don', 'ka', 'bigDon', 'roll']);
});

test('demo song has drum charts that get easier', () => {
  const chart = normalizeChart(buildDemoChart());
  const counts = ['easy', 'medium', 'hard', 'expert'].map((d) => chart.drum[d].length);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1], `${counts}`);
  assert.ok(counts[0] > 10);
});
