// Runs auto-charting off the main thread so the page stays responsive.
import { autoChart } from './analysis.js';

self.onmessage = (e) => {
  const { channels, sampleRate, meta } = e.data;
  try {
    const chart = autoChart(channels, sampleRate, meta, (p) => self.postMessage({ type: 'progress', p }));
    self.postMessage({ type: 'done', chart });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
