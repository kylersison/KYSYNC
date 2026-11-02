// AudioEngine: the game clock.
//
// Rule #1 of rhythm games: never time things off frames or setTimeout.
// Everything here is derived from the AudioContext clock, and "now" means
// "the sample the player is hearing right now" (output latency included).
//
// A song plays as one or more tracks started on the same sample: just the mix,
// or one track per instrument stem so the one you're playing can drop out on misses.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.tracks = [];     // [{ name, buffer, gain: GainNode, source }]
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
        // Right after a suspend/resume the output timestamp can be stale, and extrapolating
        // from it would jump ahead by the whole pause. Nothing can be heard past currentTime.
        return Math.min(ctx.currentTime, ts.contextTime + (perfMs - ts.performanceTime) / 1000);
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

  /**
   * Start a song. `tracks` is an AudioBuffer (just the mix) or [{ name, buffer }].
   * Song time 0 lands `leadIn` seconds from now.
   */
  play(tracks, leadIn = 2) {
    const ctx = this.ensure();
    this.stop();
    this.frozen = null;
    const list = tracks instanceof AudioBuffer ? [{ name: 'mix', buffer: tracks }] : tracks;
    this.tracks = list.map(({ name, buffer }) => {
      const gain = ctx.createGain();
      gain.connect(this.master);
      return { name, buffer, gain, source: null, target: 1 };
    });
    this._startSources(-leadIn, 0);
  }

  /** (Re)start every track so that song time `songTime` is heard `delay` s from now. */
  _startSources(songTime, delay = 0.06) {
    const ctx = this.ctx;
    const c0 = ctx.currentTime + delay;
    this.startAt = c0 - songTime;
    for (const t of this.tracks) {
      const src = ctx.createBufferSource();
      src.buffer = t.buffer;
      src.connect(t.gain);
      const offset = Math.max(0, songTime);
      if (offset < t.buffer.duration) src.start(Math.max(c0, this.startAt), offset);
      t.source = src;
    }
  }

  _stopSources() {
    for (const t of this.tracks) {
      if (!t.source) continue;
      try { t.source.stop(); } catch { /* never started or already stopped */ }
      t.source.disconnect();
      t.source = null;
    }
  }

  stop() {
    this._stopSources();
    for (const t of this.tracks) t.gain.disconnect();
    this.tracks = [];
  }

  /** Freeze the clock (at `at`, or wherever we are now) and suspend audio. */
  async pause(at = null) {
    if (!this.ctx || this.frozen != null) return;
    this.frozen = at ?? this.now();
    await this.ctx.suspend();
  }

  /** Unfreeze and carry on from exactly where we paused. */
  async resume() {
    if (!this.ctx) return;
    await this.ctx.resume();
    this.frozen = null;
  }

  /** Unfreeze, but restart playback from `songTime` (used for the run-up after a pause). */
  async resumeFrom(songTime) {
    if (!this.ctx) return;
    this.frozen = songTime; // the clock reads the run-up start while the context wakes up
    this._stopSources();
    await this.ctx.resume();
    this._startSources(songTime);
    this.frozen = null;
  }

  /** Volume of one track (0..1), e.g. to drop the instrument you're playing on a miss. */
  setTrackGain(name, value, timeConstant = 0.03) {
    const t = this.tracks.find((x) => x.name === name);
    if (!t || t.target === value) return;
    t.target = value;
    const g = t.gain.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    if (this.ctx.state === 'running') g.setTargetAtTime(value, this.ctx.currentTime, timeConstant);
    else g.value = value;
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
