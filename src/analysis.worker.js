// Runs auto-charting off the main thread so the page stays responsive.
//   { channels, sampleRate, meta }               → full-song chart
//   { mix, stems, sampleRate, meta }             → full-song chart + one chart per instrument
import { autoChart } from './analysis.js';
import { autoChartSong } from './instrumentChart.js';

self.onmessage = (e) => {
  const { channels, mix, stems, sampleRate, meta } = e.data;
  const onProgress = (p) => self.postMessage({ type: 'progress', p });
  try {
    const chart = stems
      ? autoChartSong({ mix, stems, rate: sampleRate, meta }, onProgress)
      : autoChart(channels, sampleRate, meta, onProgress);
    self.postMessage({ type: 'done', chart });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
