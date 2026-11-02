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

/** Highway + drum charts for one part (the full song, or one instrument). */
function normalizeParts(raw, bpm, offset) {
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

  // Drum (Taiko) charts: use the chart's own if it has one, else convert the highway chart.
  let drumGiven = {};
  if (Array.isArray(raw.drum)) drumGiven.expert = cleanDrumNotes(raw.drum);
  else if (raw.drum && typeof raw.drum === 'object') {
    for (const [k, v] of Object.entries(raw.drum)) drumGiven[k] = cleanDrumNotes(v);
  }
  const drumHardest = DIFFICULTY_ORDER.slice().reverse().find((d) => drumGiven[d]?.length);
  const drumBase = drumHardest ? drumGiven[drumHardest] : drumFromHighway(difficulties.expert);
  const drumDerived = deriveDrumDifficulties(drumBase, bpm, offset);
  const drum = {};
  for (const d of DIFFICULTY_ORDER) drum[d] = drumGiven[d] ?? drumDerived[d];
  return { difficulties, drum };
}

/** Instruments that can be played on their own, in menu order. */
export const INSTRUMENTS = ['drums', 'bass', 'guitar', 'piano', 'other', 'vocals'];

/** Menu name for an instrument. 'other' is the lead line unless guitar/keys have their own stems. */
export function instrumentLabel(name, available = []) {
  if (name === 'other') return available.includes('guitar') || available.includes('piano') ? 'Other' : 'Lead';
  return { mix: 'Full song', drums: 'Drums', bass: 'Bass', guitar: 'Guitar', piano: 'Keys', vocals: 'Vocals' }[name] || name;
}

/**
 * Validate a chart object and fill in any missing difficulties.
 * Songs split into stems also carry { instruments: { drums: { difficulties, drum }, ... } }.
 */
export function normalizeChart(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Chart must be a JSON object');
  const bpm = Number(raw.bpm) || 120;
  const offset = Number(raw.offset) || 0;
  const { difficulties, drum } = normalizeParts(raw, bpm, offset);

  const instruments = {};
  if (raw.instruments && typeof raw.instruments === 'object') {
    for (const name of INSTRUMENTS) {
      if (!raw.instruments[name]) continue;
      try {
        instruments[name] = normalizeParts(raw.instruments[name], bpm, offset);
      } catch { /* an empty or broken instrument chart just isn't offered */ }
    }
  }

  return {
    title: raw.title || 'Untitled',
    artist: raw.artist || 'Unknown',
    bpm,
    offset,
    difficulties,
    drum,
    instruments,
    beats: Array.isArray(raw.beats) ? raw.beats.map(Number).filter(Number.isFinite) : null,
    barPhase: Number(raw.barPhase) || 0,
  };
}

// ---------------- Drum (Taiko) charts ----------------
// Drum notes: { time, type: 'don' | 'ka' | 'bigDon' | 'bigKa' | 'roll', duration? }

export const DRUM_TYPES = ['don', 'ka', 'bigDon', 'bigKa', 'roll'];

function cleanDrumNotes(notes) {
  if (!Array.isArray(notes)) throw new Error('Drum notes must be an array');
  return notes
    .map((n) => ({
      time: Number(n.time),
      type: DRUM_TYPES.includes(n.type) ? n.type : 'don',
      duration: n.type === 'roll' ? Math.max(0.1, Number(n.duration) || 0.5) : 0,
    }))
    .filter((n) => Number.isFinite(n.time))
    .sort((a, b) => a.time - b.time);
}

/** Convert a 5-lane chart: low lanes → don, high lanes → ka, holds → rolls, chords → big. */
export function drumFromHighway(notes) {
  const out = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const chord = [n];
    while (i + 1 < notes.length && Math.abs(notes[i + 1].time - n.time) < 0.005) chord.push(notes[++i]);
    const prev = out[out.length - 1];
    if (prev?.type === 'roll' && n.time < prev.time + prev.duration + 0.05) continue;
    if (n.duration > 0) {
      out.push({ time: n.time, type: 'roll', duration: n.duration });
      continue;
    }
    const kind = n.lane <= 2 ? 'don' : 'ka';
    const big = chord.length > 1;
    out.push({ time: n.time, type: big ? (kind === 'don' ? 'bigDon' : 'bigKa') : kind, duration: 0 });
  }
  return out;
}

/** Easier drum charts from an expert one, using the beat grid. */
export function deriveDrumDifficulties(expert, bpm, offset = 0) {
  const beat = 60 / bpm;
  const pos = (t) => (t - offset) / beat;
  const on = (t, step) => Math.abs(pos(t) / step - Math.round(pos(t) / step)) < 0.08;
  const big = (n) => n.type === 'bigDon' || n.type === 'bigKa';
  const thin = (notes, gap) => {
    const out = [];
    for (const n of notes) {
      const prev = out[out.length - 1];
      const prevEnd = prev ? prev.time + (prev.duration || 0) : -Infinity;
      if (prev && n.time - prevEnd < gap) continue;
      out.push(n);
    }
    return out;
  };
  const hard = expert.filter((n) => n.type === 'roll' || big(n) || on(n.time, 0.5));
  const medium = thin(hard.filter((n) => n.type === 'roll' || big(n) || on(n.time, 1)), beat * 0.9);
  const easy = thin(medium.filter((n) => n.type === 'roll' || on(n.time, 2)), beat * 1.8)
    .map((n) => (big(n) ? { ...n, type: n.type === 'bigDon' ? 'don' : 'ka' } : n));
  return { easy, medium, hard, expert };
}
