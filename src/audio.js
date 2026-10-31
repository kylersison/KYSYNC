// AudioEngine: the game clock.
//
// Rule #1 of rhythm games: never time things off frames or setTimeout.
// Everything here is derived from the AudioContext clock, and "now" means
// "the sample the player is hearing right now" (output latency included).

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.startAt = 0;     // context time at which song time = 0
    this.frozen = null;   // song time while paused
    this.volume = 0.8;    // 0..1, applied through the master gain
    this.master = null;
  }

  /** Must be called from a user gesture (click / key) the first time. */
  ensure() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume * this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended' && this.frozen == null) this.ctx.resume();
    return this.ctx;
  }

  async decode(arrayBuffer) {
    return this.ensure().decodeAudioData(arrayBuffer);
  }

  /**
   * Context time being heard at a given performance.now() timestamp.
   * Keyboard events carry event.timeStamp on the same clock, so input is
   * judged at the moment the key went down, not when the handler ran.
   */
  heardTime(perfMs = performance.now()) {
    const ctx = this.ctx;
    if (!ctx) return 0;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime > 0 && ts.performanceTime > 0) {
        return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
      }
    }
    const latency = ctx.outputLatency || ctx.baseLatency || 0;
    return ctx.currentTime - latency - (performance.now() - perfMs) / 1000;
  }

  /** Current song time in seconds (negative during the lead-in). */
  now() {
    if (this.frozen != null) return this.frozen;
    return this.heardTime() - this.startAt;
  }

  /** Song time at a given event timestamp. */
  timeAt(perfMs) {
    if (this.frozen != null) return this.frozen;
    return this.heardTime(perfMs) - this.startAt;
  }

  play(buffer, leadIn = 2) {
    const ctx = this.ensure();
    this.stop();
    this.frozen = null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.master);
    this.startAt = ctx.currentTime + leadIn;
    src.start(this.startAt);
    this.source = src;
  }

  stop() {
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  async pause() {
    if (!this.ctx || this.frozen != null) return;
    this.frozen = this.now();
    await this.ctx.suspend();
  }

  async resume() {
    if (!this.ctx) return;
    await this.ctx.resume();
    this.frozen = null;
  }

  /** 0..1. Squared so the slider feels even to the ear. */
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (!this.master) return;
    const g = this.master.gain, target = this.volume * this.volume;
    g.cancelScheduledValues(this.ctx.currentTime);
    // While paused the audio clock is stopped, so ramps wouldn't run: set it directly.
    if (this.ctx.state === 'running') g.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    else g.value = target;
  }

  get paused() {
    return this.frozen != null;
  }

  /** Short click used by the calibration screen. */
  scheduleClick(when, accent = false) {
    const ctx = this.ensure();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = accent ? 1500 : 1000;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.5, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
    o.connect(g).connect(this.master);
    o.start(when);
    o.stop(when + 0.08);
  }
}
