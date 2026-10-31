// Chart format + difficulty derivation.
//
// A chart is JSON like:
// {
//   "title": "Song name",
//   "artist": "Artist",
//   "bpm": 128,
//   "offset": 0.0,            // seconds from audio start to beat 1 of bar 1
//   "difficulties": {         // any subset of easy / medium / hard / expert
//     "expert": [ { "time": 3.75, "lane": 2, "duration": 0 }, ... ]
//   }
// }
// or the short form { title, artist, bpm, offset, notes: [...] }, which is treated
// as the expert chart; easier difficulties are generated from it automatically.

import { LANE_COUNT, DIFFICULTY_ORDER } from './constants.js';

function cleanNotes(notes) {
  if (!Array.isArray(notes)) throw new Error('Chart notes must be an array');
  return notes
    .map((n) => ({
      time: Number(n.time),
      lane: Math.round(Number(n.lane)),
      duration: Math.max(0, Number(n.duration) || 0),
    }))
    .filter((n) => Number.isFinite(n.time) && n.lane >= 0 && n.lane < LANE_COUNT)
    .sort((a, b) => a.time - b.time || a.lane - b.lane);
}

/** Build easy/medium/hard charts from an expert chart using the beat grid. */
export function deriveDifficulties(expert, bpm, offset = 0) {
  const beat = 60 / bpm;
  const beatPos = (t) => (t - offset) / beat;
  const nearInt = (x, step = 1) => Math.abs(x / step - Math.round(x / step)) < 0.08;

  const thin = (notes, minGap) => {
    const out = [];
    for (const n of notes) {
      const prev = out[out.length - 1];
      if (prev && n.time - prev.time < minGap) continue;
      out.push(n);
    }
    return out;
  };

  // Hard: no chords (keep one note per timestamp).
  const hard = [];
  for (const n of expert) {
    const prev = hard[hard.length - 1];
    if (prev && Math.abs(prev.time - n.time) < 0.005) continue;
    hard.push({ ...n });
  }

  // Medium: on-beat notes and holds, thinned.
  const medium = thin(hard.filter((n) => n.duration > 0 || nearInt(beatPos(n.time))), beat * 0.9);

  // Easy: strong beats (every other beat) and holds, three lanes only.
  const squeeze = [0, 0, 1, 2, 2];
  const easy = thin(
    medium.filter((n) => n.duration > 0 || nearInt(beatPos(n.time), 2)),
    beat * 1.8,
  ).map((n) => ({ ...n, lane: squeeze[n.lane] }));

  return { easy, medium, hard, expert };
}

/** Validate a chart object and fill in any missing difficulties. */
export function normalizeChart(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Chart must be a JSON object');
  const bpm = Number(raw.bpm) || 120;
  const offset = Number(raw.offset) || 0;

  let given = {};
  if (raw.difficulties) {
    for (const [k, v] of Object.entries(raw.difficulties)) given[k] = cleanNotes(v);
  } else if (raw.notes) {
    given.expert = cleanNotes(raw.notes);
  } else {
    throw new Error('Chart needs "notes" or "difficulties"');
  }

  const hardest = DIFFICULTY_ORDER.slice().reverse().find((d) => given[d]?.length);
  if (!hardest) throw new Error('Chart has no notes');
  const derived = deriveDifficulties(given[hardest], bpm, offset);

  const difficulties = {};
  for (const d of DIFFICULTY_ORDER) difficulties[d] = given[d] ?? derived[d];

  return {
    title: raw.title || 'Untitled',
    artist: raw.artist || 'Unknown',
    bpm,
    offset,
    difficulties,
  };
}
