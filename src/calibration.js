// Latency calibration: play a click track, the player taps along,
// and the median (tap - click) becomes their input offset.

const CLICKS = 24;
const WARMUP = 4;      // ignore taps on the first few clicks
const INTERVAL = 0.5;  // seconds (120 BPM)

export class Calibration {
  constructor(engine, { onUpdate, onDone }) {
    this.engine = engine;
    this.onUpdate = onUpdate;
    this.onDone = onDone;
    this.clicks = [];
    this.samples = [];
    this.running = false;
  }

  start() {
    const ctx = this.engine.ensure();
    const t0 = ctx.currentTime + 1.0;
    this.clicks = Array.from({ length: CLICKS }, (_, i) => t0 + i * INTERVAL);
    this.clicks.forEach((t, i) => this.engine.scheduleClick(t, i % 4 === 0));
    this.samples = [];
    this.running = true;
    this.onUpdate(this.status());
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish(), (1.0 + CLICKS * INTERVAL + 0.5) * 1000);
  }

  tap(perfMs) {
    if (!this.running) return;
    const heard = this.engine.heardTime(perfMs);
    let best = null;
    this.clicks.forEach((c, i) => {
      if (i < WARMUP) return;
      if (best == null || Math.abs(heard - c) < Math.abs(heard - best)) best = c;
    });
    if (best == null) return;
    const delta = heard - best;
    if (Math.abs(delta) < INTERVAL / 2) this.samples.push(delta);
    this.onUpdate(this.status());
  }

  /** 0..1 pulse that peaks on each audible click, for the visual metronome. */
  pulse() {
    if (!this.running) return 0;
    const heard = this.engine.heardTime();
    for (const c of this.clicks) {
      const d = heard - c;
      if (d >= 0 && d < 0.25) return 1 - d / 0.25;
    }
    return 0;
  }

  median() {
    if (!this.samples.length) return null;
    const s = [...this.samples].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  status() {
    const med = this.median();
    return {
      taps: this.samples.length,
      needed: CLICKS - WARMUP,
      offsetMs: med == null ? null : Math.round(med * 1000),
      running: this.running,
    };
  }

  finish() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.timer);
    const st = this.status();
    this.onDone(st.taps >= 6 ? st.offsetMs : null);
  }

  cancel() {
    this.running = false;
    clearTimeout(this.timer);
  }
}
