import './style.css';
import { Game } from './game.js';
import { normalizeChart } from './chart.js';
import { buildDemoChart, renderDemoAudio } from './demoSong.js';
import { makePaper } from './theme.js';
import { library } from './library.js';
import { CHART_VERSION, autoChart } from './analysis.js';

// Menu panels use the same generated washi as the game canvas, just lighter.
document.documentElement.style.setProperty(
  '--washi', `url(${makePaper(520, 760, 1, '#f4ecda').toDataURL()})`,
);

const game = new Game(document.querySelector('#game'));

// Built-in demo song (synthesized, no audio files needed)
const demoRaw = buildDemoChart();
game.addSong({
  id: 'demo',
  chart: normalizeChart(demoRaw),
  load: () => renderDemoAudio(demoRaw),
  pending: renderDemoAudio(demoRaw), // start synthesizing right away so Play is instant
});

// ---------- your songs ----------

function addLibrarySong(entry, select = false) {
  return game.addSong({
    id: entry.id,
    chart: normalizeChart(entry.chart),
    load: async (engine) => engine.decode(await entry.audio.arrayBuffer()),
    onRemove: () => library.remove(entry.id),
  }, select);
}

// Songs added in earlier sessions. Auto-charted songs from an older version of the
// charter are re-charted in the background (hand-made charts are left alone).
library.all().then(async (entries) => {
  const stale = [];
  for (const e of entries) {
    addLibrarySong(e);
    if (!e.handMade && e.chart.version !== CHART_VERSION) stale.push(e);
  }
  for (const e of stale) {
    try {
      status.textContent = `Updating the chart for "${e.chart.title}"…`;
      const buffer = await game.engine.decode(await e.audio.arrayBuffer());
      const raw = await analyze(buffer, { title: e.chart.title, artist: e.chart.artist }, () => {});
      e.chart = raw;
      await library.save(e);
      const song = game.songs.find((s) => s.id === e.id);
      if (song) { song.chart = normalizeChart(raw); song.buffer = buffer; }
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

/** Analyze decoded audio in a worker; resolves to raw chart JSON. */
function autoChartInWorker(buffer, meta, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module' });
    const channels = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice());
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
    worker.postMessage({ channels, sampleRate: buffer.sampleRate, meta }, channels.map((c) => c.buffer));
  });
}

/**
 * Analyze in a worker when possible. Some embedded browsers (e.g. editor preview panes)
 * block module workers, so fall back to running on the page: it pauses the UI for a few
 * seconds but always works.
 */
async function analyze(buffer, meta, onProgress) {
  try {
    return await autoChartInWorker(buffer, meta, onProgress);
  } catch (err) {
    console.warn('Worker analysis failed, analyzing on the page instead:', err);
    onProgress(0.05);
    await new Promise((r) => setTimeout(r, 60)); // let the loading screen paint first
    const channels = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));
    return autoChart(channels, buffer.sampleRate, meta);
  }
}

const audioInput = document.querySelector('#audio-file');
const chartInput = document.querySelector('#chart-file');
const status = document.querySelector('#custom-status');

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
    addLibrarySong(entry, true);
    game.songs[game.songs.length - 1].buffer = buffer; // already decoded
    status.textContent = `Added "${raw.title}" · ${Math.round(raw.bpm)} BPM`;
  } catch (err) {
    console.error(err);
    status.textContent = `Couldn't add that song: ${err.message}`;
  } finally {
    game.setLoading(null);
  }
});

// Handy for debugging in the browser console: kysync.judge, kysync.settings, ...
if (import.meta.env.DEV) window.kysync = game;
