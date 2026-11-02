import './style.css';
import { Game } from './game.js';
import { normalizeChart } from './chart.js';
import { buildDemoChart, buildDemoInstruments, renderDemoAudio, renderDemoStems } from './demoSong.js';
import { themes, applyTheme } from './themes.js';
import { initThemePanel } from './themePanel.js';
import { library } from './library.js';
import { CHART_VERSION, autoChart } from './analysis.js';
import { INSTRUMENT_CHART_VERSION, autoChartSong } from './instrumentChart.js';
import {
  AUDIO_FILE, ANALYSIS_RATE, stemFromFilename, splitInBrowser, hasWebGPU, modelIsCached,
  analysisSamples, decodeStems,
} from './stems.js';
import { encodeStem } from './stemCodec.js';

// Colors first, so the canvas paper and the menus start out in your theme.
applyTheme(themes.current);

const game = new Game(document.querySelector('#game'));
const status = document.querySelector('#custom-status');

// Theme changes: repaint the canvas paper (the menus follow through CSS variables).
themes.onChange(() => { for (const r of Object.values(game.renderers)) r.resize(); });
initThemePanel(game);

// Built-in demo song (synthesized, no audio files needed). Its stems come straight from
// the synth, so you can try playing drums, bass or lead without splitting anything.
const demoRaw = buildDemoChart();
demoRaw.instruments = buildDemoInstruments(demoRaw);
game.addSong({
  id: 'demo',
  chart: normalizeChart(demoRaw),
  load: () => renderDemoAudio(demoRaw),
  pending: renderDemoAudio(demoRaw), // start synthesizing right away so Play is instant
  loadStems: () => renderDemoStems(demoRaw),
});

// ---------- your songs ----------

function addLibrarySong(entry, select = false) {
  const song = {
    id: entry.id,
    entry,
    chart: normalizeChart(entry.chart),
    onRemove: () => library.remove(entry.id),
  };
  wireSong(song);
  game.addSong(song, select);
  return song;
}

/** Hook up how a library song loads its audio, based on what the entry has. */
function wireSong(song) {
  const { entry } = song;
  song.load = entry.audio ? async (engine) => engine.decode(await entry.audio.arrayBuffer()) : null;
  song.loadStems = entry.stems ? (onProgress) => decodeStems(entry.stems, onProgress) : null;
  song.canSplit = !entry.stems && !!entry.audio;
}

// Songs added in earlier sessions. Auto-charted songs from an older version of the
// charter are re-charted in the background (hand-made charts are left alone).
library.all().then(async (entries) => {
  const stale = [];
  for (const e of entries) {
    addLibrarySong(e);
    const oldMix = !e.handMade && e.chart.version !== CHART_VERSION;
    const oldInstruments = e.stems && e.chart.instrumentsVersion !== INSTRUMENT_CHART_VERSION;
    if (oldMix || oldInstruments) stale.push(e);
  }
  for (const e of stale) {
    try {
      status.textContent = `Updating the chart for "${e.chart.title}"…`;
      const meta = { title: e.chart.title, artist: e.chart.artist };
      const mix = e.audio ? await game.engine.decode(await e.audio.arrayBuffer()) : null;
      let raw;
      if (e.stems) {
        const stems = await decodeStems(e.stems);
        raw = await analyzeWithStems(mix, stems, meta, () => {});
        if (e.handMade) raw = { ...e.chart, instruments: raw.instruments, instrumentsVersion: raw.instrumentsVersion };
      } else {
        raw = await analyze(mix, meta, () => {});
      }
      e.chart = raw;
      await library.save(e);
      const song = game.songs.find((s) => s.id === e.id);
      if (song) { song.chart = normalizeChart(raw); if (mix) song.buffer = mix; }
      game.refreshSongs();
    } catch (err) {
      console.warn('Re-chart failed for', e.chart.title, err);
    }
  }
  if (stale.length) status.textContent = `Updated ${stale.length} song chart${stale.length > 1 ? 's' : ''}.`;
});

/** "Artist - Title.mp3" → { artist, title } */
function metaFromFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { title: base, artist: 'Auto-charted' };
}

// ---------- charting (in a worker, with an on-page fallback) ----------

/** Run the analysis worker; resolves to raw chart JSON. */
function runWorker(message, transfer, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress(msg.p);
      else {
        worker.terminate();
        if (msg.type === 'done') resolve(msg.chart);
        else reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      worker.terminate();
      const where = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '';
      reject(new Error((e.message || 'the analysis worker could not start') + where));
    };
    worker.postMessage(message, transfer);
  });
}

/**
 * Analyze in a worker when possible. Some embedded browsers (e.g. editor preview panes)
 * block module workers, so fall back to running on the page: it pauses the UI for a few
 * seconds but always works.
 */
async function analyze(buffer, meta, onProgress) {
  const channels = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice());
  try {
    return await runWorker({ channels, sampleRate: buffer.sampleRate, meta }, channels.map((c) => c.buffer), onProgress);
  } catch (err) {
    console.warn('Worker analysis failed, analyzing on the page instead:', err);
    onProgress(0.05);
    await new Promise((r) => setTimeout(r, 60)); // let the loading screen paint first
    const chans = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chans.push(buffer.getChannelData(c));
    return autoChart(chans, buffer.sampleRate, meta);
  }
}

/** Chart the full song plus one chart per stem. `mix` may be null (stems only). */
async function analyzeWithStems(mix, stemBuffers, meta, onProgress) {
  const prep = () => ({
    mix: mix ? analysisSamples(mix) : null,
    stems: Object.fromEntries(Object.entries(stemBuffers).map(([n, b]) => [n, analysisSamples(b)])),
  });
  const { mix: m, stems } = prep();
  const transfer = [m?.buffer, ...Object.values(stems).map((s) => s.buffer)].filter(Boolean);
  try {
    return await runWorker({ mix: m, stems, sampleRate: ANALYSIS_RATE, meta }, transfer, onProgress);
  } catch (err) {
    console.warn('Worker analysis failed, analyzing on the page instead:', err);
    await new Promise((r) => setTimeout(r, 60));
    const again = prep(); // the first copies were handed to the worker
    return autoChartSong({ mix: again.mix, stems: again.stems, rate: ANALYSIS_RATE, meta });
  }
}

// ---------- adding songs ----------

const audioInput = document.querySelector('#audio-file');
const chartInput = document.querySelector('#chart-file');
const stemInput = document.querySelector('#stem-folder');

audioInput.addEventListener('change', async () => {
  const file = audioInput.files[0];
  audioInput.value = '';
  if (!file) return;
  const chartFile = chartInput.files[0];
  chartInput.value = '';
  status.textContent = '';
  const meta = metaFromFilename(file.name);

  try {
    game.setLoading(`Decoding ${file.name}…`, 0.02);
    const buffer = await game.engine.decode(await file.arrayBuffer());

    let raw;
    if (chartFile) {
      raw = JSON.parse(await chartFile.text());
      raw.title ||= meta.title;
      raw.artist ||= meta.artist;
    } else {
      raw = await analyze(buffer, meta, (p) =>
        game.setLoading(`Finding the beat in "${meta.title}"…`, 0.05 + p * 0.95));
    }
    normalizeChart(raw); // validate before saving

    const entry = { id: `song-${Date.now()}`, chart: raw, audio: file, added: Date.now(), handMade: !!chartFile };
    await library.save(entry);
    const song = addLibrarySong(entry, true);
    song.buffer = buffer; // already decoded
    status.textContent = `Added "${raw.title}" · ${Math.round(raw.bpm)} BPM. Split it into instruments from its card to play drums, bass, vocals or lead.`;
  } catch (err) {
    console.error(err);
    status.textContent = `Couldn't add that song: ${err.message}`;
  } finally {
    game.setLoading(null);
  }
});

/**
 * Chart a song's stems, encode them for storage, and save. `from` is where the loading
 * bar already is (splitting fills the first part of it).
 */
async function saveWithStems(entry, stems, mix, from) {
  const meta = { title: entry.chart?.title || 'Untitled', artist: entry.chart?.artist || 'Auto-charted', ...entry.meta };
  const raw = await analyzeWithStems(mix, stems, meta, (p) =>
    game.setLoading(`Charting each instrument in "${meta.title}"…`, from + p * (0.94 - from)));
  if (!Object.keys(raw.instruments).length) throw new Error('none of the stems had enough in them to chart');

  entry.chart = entry.handMade
    ? { ...entry.chart, instruments: raw.instruments, instrumentsVersion: raw.instrumentsVersion }
    : raw;
  normalizeChart(entry.chart); // validate before saving

  const names = Object.keys(stems);
  const stored = {};
  for (let i = 0; i < names.length; i++) {
    game.setLoading('Saving the instruments…', 0.94 + (i / names.length) * 0.06);
    stored[names[i]] = await encodeStem(stems[names[i]]);
  }
  entry.stems = stored;
  delete entry.meta;
  await library.save(entry);
  return raw;
}

/** Split a saved song into drums / bass / vocals / lead in the browser. */
async function splitSong(song) {
  const { entry } = song;
  if (!entry?.audio || game.busy) return;
  const gpu = await hasWebGPU();
  if (!gpu && !confirm('This browser doesn\'t have WebGPU, so splitting runs on the CPU and can take 10–40 minutes for one song. Try anyway?')) return;
  if (gpu && !(await modelIsCached()) && !confirm('Splitting songs needs a one-time 180 MB download of the Demucs model (it stays cached in this browser). Continue?')) return;

  game.busy = true;
  status.textContent = '';
  try {
    game.setLoading('Decoding the song…', 0);
    const mix = song.buffer ?? await game.engine.decode(await entry.audio.arrayBuffer());
    song.buffer = mix;
    const stems = await splitInBrowser(mix, (text, p) => game.setLoading(text, p));
    await saveWithStems(entry, stems, mix, 0.8);
    for (const s of game.songs) if (s !== song) { s.stemBuffers = null; s.stemPending = null; }
    song.chart = normalizeChart(entry.chart);
    song.stemBuffers = stems;
    wireSong(song);
    game.selected = song;
    game.refreshSongs();
    const n = Object.keys(song.chart.instruments).length;
    status.textContent = `Split "${song.chart.title}": ${n} instrument${n > 1 ? 's' : ''} to play. Pick one under Instrument.`;
  } catch (err) {
    console.error(err);
    status.textContent = `Couldn't split that song: ${err.message}`;
  } finally {
    game.busy = false;
    game.setLoading(null);
  }
}
game.onSplit = splitSong;
game.refreshSongs();

/**
 * Pick a folder of stems (Demucs, UVR, …). A folder with several song folders inside
 * (like Demucs' separated/htdemucs_6s) imports each one. The folder name becomes the
 * title ("Artist - Title" works), and a file that isn't a stem is used as the full song.
 */
stemInput.addEventListener('change', async () => {
  const files = [...stemInput.files].filter((f) => AUDIO_FILE.test(f.name));
  stemInput.value = '';
  status.textContent = '';
  if (!files.length) { status.textContent = 'No audio files in that folder.'; return; }

  const groups = new Map();
  for (const f of files) {
    const parts = (f.webkitRelativePath || f.name).split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }

  const generic = (n) => /^(mix|original|song|full)\b/i.test(n); // what tools/split_stems.py calls the full song
  const added = [], skipped = [];
  game.busy = true;
  try {
    for (const [dir, list] of groups) {
      const stems = {}, others = [];
      for (const f of list) {
        const kind = stemFromFilename(f.name);
        const exact = kind && f.name.toLowerCase().startsWith(kind);
        if (kind && (!stems[kind] || (exact && !stems[kind].exact))) {
          if (stems[kind]) others.push(stems[kind].file);
          stems[kind] = { file: f, exact };
        } else others.push(f);
      }
      const folder = dir.split('/').pop() || '';
      if (!Object.keys(stems).length) { skipped.push(folder || list[0].name); continue; }
      const mixFile = others.find((f) => generic(f.name)) ?? others.sort((a, b) => b.size - a.size)[0] ?? null;
      const meta = metaFromFilename(folder && !/^(htdemucs\w*|separated|stems)$/i.test(folder) ? folder
        : mixFile && !generic(mixFile.name) ? mixFile.name : 'Imported song');

      const names = Object.keys(stems);
      const decoded = {};
      for (let i = 0; i < names.length; i++) {
        game.setLoading(`Decoding ${meta.title}: ${names[i]}…`, (i / (names.length + 1)) * 0.3);
        decoded[names[i]] = await game.engine.decode(await stems[names[i]].file.arrayBuffer());
      }
      const mix = mixFile ? await game.engine.decode(await mixFile.arrayBuffer()) : null;

      const entry = { id: `song-${Date.now()}-${added.length}`, audio: mixFile, added: Date.now(), handMade: false, stemSource: 'import', meta };
      try {
        await saveWithStems(entry, decoded, mix, 0.3);
      } catch (err) {
        skipped.push(`${meta.title} (${err.message})`);
        continue;
      }
      for (const s of game.songs) { s.stemBuffers = null; s.stemPending = null; }
      const song = addLibrarySong(entry, true);
      song.stemBuffers = decoded;
      if (mix) song.buffer = mix;
      added.push(meta.title);
    }
    status.textContent = [
      added.length ? `Added ${added.map((t) => `"${t}"`).join(', ')} with ${added.length > 1 ? 'their' : 'its'} instruments.` : '',
      skipped.length ? `Skipped ${skipped.join(', ')}. Stem files need names like vocals, drums, bass, other, guitar or piano.` : '',
    ].filter(Boolean).join(' ');
  } catch (err) {
    console.error(err);
    status.textContent = `Couldn't import those stems: ${err.message}`;
  } finally {
    game.busy = false;
    game.setLoading(null);
  }
});

// Handy for debugging in the browser console: kysync.judge, kysync.settings, ...
if (import.meta.env.DEV) window.kysync = game;
