import './style.css';
import { Game } from './game.js';
import { normalizeChart } from './chart.js';
import { buildDemoChart, renderDemoAudio } from './demoSong.js';
import { makePaper } from './theme.js';

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

// Custom song: pick an audio file + a chart JSON
const audioInput = document.querySelector('#audio-file');
const chartInput = document.querySelector('#chart-file');
const status = document.querySelector('#custom-status');

async function tryAddCustom() {
  const audio = audioInput.files[0];
  const chartFile = chartInput.files[0];
  if (!audio && !chartFile) return;
  if (!chartFile) {
    status.textContent = 'Now pick a chart JSON. (Auto-charting from audio is step 3 of the roadmap.)';
    return;
  }
  if (!audio) {
    status.textContent = 'Now pick the audio file for this chart.';
    return;
  }
  try {
    const chart = normalizeChart(JSON.parse(await chartFile.text()));
    if (chart.title === 'Untitled') chart.title = audio.name.replace(/\.[^.]+$/, '');
    game.addSong({
      id: `custom-${chart.title}`,
      chart,
      load: async (engine) => engine.decode(await audio.arrayBuffer()),
    }, true);
    status.textContent = `Added "${chart.title}".`;
    audioInput.value = '';
    chartInput.value = '';
  } catch (err) {
    status.textContent = `Chart error: ${err.message}`;
  }
}

audioInput.addEventListener('change', tryAddCustom);
chartInput.addEventListener('change', tryAddCustom);

// Handy for debugging in the browser console: kysync.judge, kysync.settings, ...
if (import.meta.env.DEV) window.kysync = game;
