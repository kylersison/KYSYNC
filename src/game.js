// Game: state machine, input, and menu/results UI wiring.
// States: menu → loading → playing ⇄ paused → countdown → playing → results, plus calibrate.
// Modes: 'drum' (Taiko-style, D F J K) and 'highway' (5 lanes, D F J K L).
// Instruments: 'mix' (the whole song) or one stem (drums, bass, vocals, …) for songs that
// have been split. Playing an instrument plays every stem, and yours drops out when you miss.

import {
  LANE_COUNT, LANE_KEYS, DIFFICULTY_ORDER, LEAD_IN, RESUME_COUNTDOWN, DUCK_LEVEL,
} from './constants.js';
import { AudioEngine } from './audio.js';
import { Judge } from './judge.js';
import { Renderer } from './renderer.js';
import { DrumJudge } from './drumJudge.js';
import { DrumRenderer } from './drumRenderer.js';
import { Calibration } from './calibration.js';
import { INSTRUMENTS, instrumentLabel } from './chart.js';

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`kysync.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`kysync.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const $ = (sel) => document.querySelector(sel);
const show = (el, on) => el.classList.toggle('hidden', !on);

/**
 * Endless fake notes for the theme screen, so colors can be judged on moving notes:
 * a lane run with a hold and a missed (grey) note for the highway, don/ka/big/roll for drums.
 */
function previewJudge(mode, t, look) {
  const step = 0.3, notes = [];
  const k0 = Math.floor((t - 0.5) / step), k1 = Math.ceil((t + look + 0.5) / step);
  const lanes = [0, 1, 2, 3, 4, 3, 2, 1];
  const drums = ['don', 'ka', 'don', 'don', 'ka', 'bigDon', 'ka', 'bigKa'];
  for (let k = k0; k <= k1; k++) {
    const time = k * step;
    const result = k % 9 === 4 ? 'miss' : time < t ? 'perfect' : null;
    if (mode === 'drum') {
      if (k % 16 >= 12) {
        if (k % 16 === 12) notes.push({ time, kind: 'roll', type: 'roll', duration: step * 3, result: null });
        continue;
      }
      const type = drums[((k % 8) + 8) % 8];
      notes.push({ time, type, kind: type.toLowerCase().includes('don') ? 'don' : 'ka', big: type.startsWith('big'), duration: 0, result });
    } else {
      const lane = lanes[((k % 8) + 8) % 8];
      const hold = ((k % 16) + 16) % 16 === 0;
      notes.push({ time, lane, duration: hold ? step * 3 : 0, result: hold ? null : result, holdState: null });
    }
  }
  return {
    notes, activeHolds: new Set(), events: [],
    score: 123456, accuracy: 0.974, combo: 42, multiplier: 4, counts: {},
  };
}

function gradeLetter(acc) {
  if (acc >= 0.97) return 'S';
  if (acc >= 0.92) return 'A';
  if (acc >= 0.85) return 'B';
  if (acc >= 0.75) return 'C';
  return 'D';
}

export class Game {
  constructor(canvas) {
    this.engine = new AudioEngine();
    this.renderers = { highway: new Renderer(canvas), drum: new DrumRenderer(canvas) };
    this.songs = [];
    this.selected = null;
    this.settings = {
      mode: store.get('mode', 'drum'),
      difficulty: store.get('difficulty', 'medium'),
      instrument: store.get('instrument', 'mix'),
      speed: store.get('speed', 1.5),
      offsetMs: store.get('offsetMs', 0),
      volume: store.get('volume', 80),
    };
    this.engine.setVolume(this.settings.volume / 100);
    this.state = 'menu';
    this.keysDown = new Array(LANE_COUNT).fill(false);
    this.judge = null;
    this.song = null;
    this.playMode = this.settings.mode;  // mode of the song in progress
    this.playInstrument = 'mix';         // instrument of the song in progress
    this.duckTrack = null;               // stem that drops out on misses
    this.resumeAt = 0;                   // song time where the resume countdown hands back control
    this.duration = 0;
    this.calibration = null;
    this.onSplit = null;                 // set by main.js: (song) => split it into instruments

    this._bindInput();
    this._bindMenu();
    this._renderSettings();
    requestAnimationFrame((ts) => this._loop(ts));
  }

  // ---------- songs ----------

  addSong(song, select = false) {
    this.songs.push(song);
    if (select || !this.selected) this.selected = song;
    this._renderSongList();
  }

  refreshSongs() {
    this._renderSongList();
  }

  removeSong(song) {
    this.songs = this.songs.filter((s) => s !== song);
    if (this.selected === song) this.selected = this.songs[0] || null;
    this._renderSongList();
  }

  /** Show the loading screen with a message, or hide it (null) and return to the menu. */
  setLoading(text, progress = null) {
    if (text == null) {
      if (this.state === 'loading') this._setState('menu');
      return;
    }
    $('#loading-text').textContent = text;
    $('#loading-fill').style.width = progress == null ? '0' : `${Math.round(progress * 100)}%`;
    if (this.state !== 'loading') this._setState('loading');
  }

  /** Instruments this song can be played as (besides the full song). */
  instrumentsOf(song) {
    const have = song?.chart.instruments || {};
    return INSTRUMENTS.filter((n) => have[n]);
  }

  /** The instrument that will actually be played for this song. */
  instrumentFor(song) {
    const want = this.settings.instrument;
    return want !== 'mix' && this.instrumentsOf(song).includes(want) ? want : 'mix';
  }

  notesFor(song, mode = this.settings.mode, diff = this.settings.difficulty, inst = this.instrumentFor(song)) {
    const part = inst === 'mix' ? song.chart : song.chart.instruments[inst];
    return mode === 'drum' ? part.drum[diff] : part.difficulties[diff];
  }

  _bestKey(song, mode, diff, inst) {
    return `best.${mode}.${song.id}.${diff}${inst === 'mix' ? '' : `.${inst}`}`;
  }

  get offsetSec() {
    return this.settings.offsetMs / 1000;
  }

  get lookahead() {
    return 1.6 / this.settings.speed;
  }

  // ---------- flow ----------

  /** The audio tracks for a song: the mix alone, or every stem (decoded once, then cached). */
  async _tracksFor(song, inst) {
    const useMix = inst === 'mix' && song.load;
    if (useMix) {
      if (!song.buffer) {
        this.setLoading('Loading song…');
        song.pending ??= song.load(this.engine); // may already be preloading
        song.buffer = await song.pending;
      }
      return song.buffer;
    }
    if (!song.stemBuffers) {
      this.setLoading('Loading instruments…', song.stemPending ? null : 0);
      this._loadStems(song, (p) => this.setLoading('Loading instruments…', p));
      song.stemBuffers = await song.stemPending;
    }
    return Object.entries(song.stemBuffers).map(([name, buffer]) => ({ name, buffer }));
  }

  /** Start decoding a song's stems (once). Stems are big once decoded, so only one song keeps them. */
  _loadStems(song, onProgress = () => {}) {
    if (!song?.loadStems || song.stemBuffers || song.stemPending) return;
    for (const s of this.songs) if (s !== song) { s.stemBuffers = null; s.stemPending = null; }
    song.stemPending = song.loadStems(onProgress).then((buffers) => {
      if (song.stemPending) song.stemBuffers = buffers; // unless another song took over meanwhile
      return buffers;
    });
    song.stemPending.catch((err) => { console.warn('Could not load instruments:', err); song.stemPending = null; });
  }

  async start() {
    if (this.busy || !this.selected) return;
    this.busy = true;
    this.engine.ensure(); // unlock audio inside the user gesture
    const song = this.selected;
    try {
      const inst = this.instrumentFor(song);
      const tracks = await this._tracksFor(song, inst);
      this.song = song;
      this.playMode = this.settings.mode;
      this.playInstrument = inst;
      this.duckTrack = inst !== 'mix' && song.stemBuffers?.[inst] ? inst : null;
      const notes = this.notesFor(song, this.playMode, this.settings.difficulty, inst);
      this.judge = this.playMode === 'drum' ? new DrumJudge(notes) : new Judge(notes);
      const list = tracks instanceof AudioBuffer ? [tracks] : tracks.map((t) => t.buffer);
      this.duration = Math.max(...list.map((b) => b.duration));
      this.keysDown.fill(false);
      this.engine.play(tracks, LEAD_IN);
      this._setState('playing');
    } catch (err) {
      console.error(err);
      alert(`Couldn't load that song: ${err.message}`);
      this._setState('menu');
    } finally {
      this.busy = false;
    }
  }

  restart() {
    if (!this.song) return;
    this.engine.stop();
    this.engine.resume();
    this.selected = this.song;
    this.start();
  }

  async pause() {
    if (this.state === 'countdown') {
      // Paused again mid-count: stay frozen at the spot the count was heading for.
      this._setState('paused');
      await this.engine.pause(this.resumeAt);
      return;
    }
    if (this.state !== 'playing') return;
    this._releaseAll();
    await this.engine.pause();
    this._setState('paused');
  }

  /**
   * Unpause with a 3-2-1: the song rewinds RESUME_COUNTDOWN seconds and plays back up to
   * where you paused, so you can catch the beat before your notes count again.
   */
  async resume() {
    if (this.state !== 'paused') return;
    this.resumeAt = this.engine.now();
    this._setState('countdown');
    await this.engine.resumeFrom(this.resumeAt - RESUME_COUNTDOWN);
    // Paused again while the audio was waking up: freeze where the count was heading.
    if (this.state === 'paused') await this.engine.pause(this.resumeAt);
  }

  /** Theme screen: the game keeps drawing behind it with preview notes. */
  openThemes() {
    if (this.state !== 'menu') return;
    this._setState('theme');
    this._sidePanel(true);
  }

  closeThemes() {
    if (this.state !== 'theme') return;
    this._setState('menu');
    this._sidePanel(false);
  }

  _sidePanel(on) {
    for (const r of Object.values(this.renderers)) { r.sidePanel = on; r.resize(); }
  }

  quitToMenu() {
    this.engine.stop();
    this.engine.resume();
    this.calibration?.cancel();
    this.judge = null;
    this._setState('menu');
    this._renderSongList();
  }

  _finish() {
    this.engine.stop();
    const j = this.judge;
    const inst = this.playInstrument;
    const key = this._bestKey(this.song, this.playMode, this.settings.difficulty, inst);
    const prevBest = store.get(key, 0);
    const score = Math.floor(j.score);
    if (score > prevBest) store.set(key, score);

    const instName = inst === 'mix' ? '' : ` · ${instrumentLabel(inst, this.instrumentsOf(this.song)).toLowerCase()}`;
    $('#r-grade').textContent = gradeLetter(j.accuracy);
    $('#r-title').textContent = `${this.song.chart.title} · ${this.playMode}${instName} · ${this.settings.difficulty}`;
    $('#r-score').textContent = score.toLocaleString();
    $('#r-best').textContent = score > prevBest ? 'New best!' : `Best ${prevBest.toLocaleString()}`;
    $('#r-acc').textContent = `${(j.accuracy * 100).toFixed(1)}%`;
    $('#r-combo').textContent = j.maxCombo;
    for (const k of ['perfect', 'great', 'good', 'miss']) $(`#r-${k}`).textContent = j.counts[k];

    const mean = j.meanDeltaMs;
    $('#r-timing').textContent = Math.abs(mean) < 12
      ? `Timing is centered (avg ${mean >= 0 ? '+' : ''}${mean.toFixed(0)} ms).`
      : `You hit ${Math.abs(mean).toFixed(0)} ms ${mean > 0 ? 'late' : 'early'} on average. Try calibrating, or nudge the offset by that much.`;

    this._setState('results');
  }

  // ---------- calibration ----------

  startCalibration() {
    this.engine.ensure();
    this._setState('calibrate');
    $('#c-result').textContent = '';
    this.calibration = new Calibration(this.engine, {
      onUpdate: (s) => {
        $('#c-taps').textContent = `${s.taps} / ${s.needed} taps`;
        $('#c-live').textContent = s.offsetMs == null ? '—' : `${s.offsetMs > 0 ? '+' : ''}${s.offsetMs} ms`;
      },
      onDone: (offsetMs) => {
        if (offsetMs == null) {
          $('#c-result').textContent = 'Not enough taps. Try again.';
        } else {
          this.settings.offsetMs = offsetMs;
          store.set('offsetMs', offsetMs);
          this._renderSettings();
          $('#c-result').textContent = `Saved offset: ${offsetMs > 0 ? '+' : ''}${offsetMs} ms`;
        }
        $('#c-start').textContent = 'Run again';
      },
    });
    $('#c-start').textContent = 'Start';
    $('#c-taps').textContent = '';
    $('#c-live').textContent = '—';
  }

  // ---------- loop ----------

  /** Your instrument fades out while you miss and comes straight back when you hit. */
  _duckFromEvents() {
    if (!this.duckTrack || !this.judge) return;
    for (const e of this.judge.events) {
      if (e.type === 'hit' || e.type === 'roll' || e.type === 'bigBonus') this.engine.setTrackGain(this.duckTrack, 1);
      else if (e.type === 'miss' || e.type === 'holdBreak') this.engine.setTrackGain(this.duckTrack, DUCK_LEVEL);
    }
  }

  _loop() {
    requestAnimationFrame((ts) => this._loop(ts));
    const inGame = this.state === 'playing' || this.state === 'paused' || this.state === 'countdown';
    const preview = this.state === 'theme';
    let t;
    let countdown = null;

    if (inGame) {
      t = this.engine.now();
      if (this.state === 'countdown') {
        countdown = this.resumeAt - t;
        if (countdown <= 0) { this._setState('playing'); countdown = null; }
      }
      if (this.state === 'playing') {
        this.judge.update(t - this.offsetSec);
        this._duckFromEvents();
        const done = this.judge.isFinished() && t > this.judge.lastNoteEnd + 1.5;
        if (done || t > this.duration + 0.25) this._finish();
      }
    } else {
      t = performance.now() / 1000; // idle background scroll
    }

    const mode = inGame ? this.playMode : this.settings.mode;
    const r = this.renderers[mode];
    const diff = this.settings.difficulty;
    const instName = inGame && this.playInstrument !== 'mix'
      ? `${instrumentLabel(this.playInstrument, this.instrumentsOf(this.song))} · ${diff}` : diff;
    // Each frame starts from a clean canvas state, so one bad frame can't leave a clip
    // or transform behind for the next (that's what shrank the highway before).
    r.g.save();
    try {
      r.draw({
        t,
        countdown,
        judge: inGame ? this.judge : preview ? previewJudge(mode, t, this.lookahead) : null,
        lookahead: inGame || preview ? this.lookahead : 1.4,
        keysDown: this.keysDown,
        bpm: inGame ? this.song.chart.bpm : 90,
        offset: inGame ? this.song.chart.offset : 0,
        beats: inGame ? this.song.chart.beats : null,
        barPhase: inGame ? this.song.chart.barPhase : 0,
        duration: this.duration,
        title: preview ? '' : this.song?.chart.title,
        difficulty: preview ? '' : instName,
      });
    } catch (err) {
      if (!this._drawErrorLogged) { console.error('Draw error:', err); this._drawErrorLogged = true; }
    } finally {
      r.g.restore();
    }

    if (this.state === 'calibrate' && this.calibration) {
      $('#c-pulse').style.transform = `scale(${1 + this.calibration.pulse() * 0.35})`;
      $('#c-pulse').style.opacity = 0.35 + this.calibration.pulse() * 0.65;
    }
  }

  // ---------- input ----------

  _releaseAll() {
    for (let l = 0; l < LANE_COUNT; l++) {
      if (this.keysDown[l] && this.judge) this.judge.release(l, this.engine.now() - this.offsetSec);
      this.keysDown[l] = false;
    }
  }

  _bindInput() {
    addEventListener('keydown', (e) => {
      const lane = LANE_KEYS.indexOf(e.code);
      if (lane !== -1 && this.state !== 'menu' && this.state !== 'loading') e.preventDefault();
      if (e.repeat) return;

      if (lane !== -1) {
        this.keysDown[lane] = true;
        if (this.state === 'playing') {
          this.judge.press(lane, this.engine.timeAt(e.timeStamp) - this.offsetSec);
        }
      }

      switch (this.state) {
        case 'playing':
        case 'countdown':
          if (e.code === 'Escape') this.pause();
          else if (e.code === 'KeyR') this.restart();
          break;
        case 'paused':
          if (e.code === 'Escape') this.resume();
          else if (e.code === 'KeyR') this.restart();
          break;
        case 'results':
          if (e.code === 'KeyR' || e.code === 'Enter') this.restart();
          else if (e.code === 'Escape') this.quitToMenu();
          break;
        case 'calibrate':
          if (e.code === 'Escape') this.quitToMenu();
          else if (e.code === 'Space' || lane !== -1) {
            e.preventDefault();
            this.calibration?.tap(e.timeStamp);
          }
          break;
        case 'theme':
          if (e.code === 'Escape') this.closeThemes();
          break;
        case 'menu':
          if (e.code === 'Enter' && document.activeElement?.tagName !== 'BUTTON') this.start();
          break;
      }
    });

    addEventListener('keyup', (e) => {
      const lane = LANE_KEYS.indexOf(e.code);
      if (lane === -1) return;
      this.keysDown[lane] = false;
      if (this.state === 'playing') this.judge.release(lane, this.engine.timeAt(e.timeStamp) - this.offsetSec);
    });

    // Losing focus while holding a key would leave a hold stuck forever.
    addEventListener('blur', () => {
      if (this.state === 'playing' || this.state === 'countdown') this.pause();
      else this.keysDown.fill(false);
    });
  }

  // ---------- menu UI ----------

  _setState(state) {
    this.state = state;
    show($('#menu'), state === 'menu');
    show($('#loading'), state === 'loading');
    show($('#pause'), state === 'paused');
    show($('#results'), state === 'results');
    show($('#calib'), state === 'calibrate');
    show($('#theme'), state === 'theme');
  }

  _bindMenu() {
    $('#play').addEventListener('click', () => this.start());
    $('#calibrate').addEventListener('click', () => this.startCalibration());
    $('#c-start').addEventListener('click', (e) => { e.currentTarget.blur(); this.calibration?.start(); });
    $('#c-back').addEventListener('click', () => this.quitToMenu());
    $('#p-resume').addEventListener('click', () => this.resume());
    $('#p-restart').addEventListener('click', () => this.restart());
    $('#p-quit').addEventListener('click', () => this.quitToMenu());
    $('#r-retry').addEventListener('click', () => this.restart());
    $('#r-menu').addEventListener('click', () => this.quitToMenu());

    $('#speed').addEventListener('input', (e) => {
      this.settings.speed = Number(e.target.value);
      store.set('speed', this.settings.speed);
      this._renderSettings();
    });

    // Volume: same setting on the menu and the pause screen, applied live
    for (const el of document.querySelectorAll('.volume-slider')) {
      el.addEventListener('input', (e) => {
        this.settings.volume = Number(e.target.value);
        store.set('volume', this.settings.volume);
        this.engine.setVolume(this.settings.volume / 100);
        this._renderSettings();
      });
    }

    for (const [id, delta] of [['#offset-down', -5], ['#offset-up', 5]]) {
      $(id).addEventListener('click', () => {
        this.settings.offsetMs += delta;
        store.set('offsetMs', this.settings.offsetMs);
        this._renderSettings();
      });
    }

    for (const b of document.querySelectorAll('#modes button')) {
      b.addEventListener('click', () => {
        this.settings.mode = b.dataset.mode;
        store.set('mode', this.settings.mode);
        this._renderSettings();
        this._renderSongList();
      });
    }

    const diffs = $('#diffs');
    for (const d of DIFFICULTY_ORDER) {
      const b = document.createElement('button');
      b.textContent = d;
      b.dataset.diff = d;
      b.addEventListener('click', () => {
        this.settings.difficulty = d;
        store.set('difficulty', d);
        this._renderSettings();
        this._renderSongList();
      });
      diffs.appendChild(b);
    }
  }

  _renderSettings() {
    const s = this.settings;
    $('#speed').value = s.speed;
    $('#speed-label').textContent = `${s.speed.toFixed(2)}×`;
    $('#offset-label').textContent = `${s.offsetMs > 0 ? '+' : ''}${s.offsetMs} ms`;
    for (const el of document.querySelectorAll('.volume-slider')) el.value = s.volume;
    for (const el of document.querySelectorAll('.volume-label')) el.textContent = `${s.volume}%`;
    for (const b of document.querySelectorAll('#diffs button')) {
      b.classList.toggle('active', b.dataset.diff === s.difficulty);
    }
    for (const b of document.querySelectorAll('#modes button, #t-preview button')) {
      b.classList.toggle('active', b.dataset.mode === s.mode);
    }
    for (const el of document.querySelectorAll('[data-for-mode]')) {
      show(el, el.dataset.forMode === s.mode);
    }
  }

  /** Instrument picker for the selected song (hidden for songs that haven't been split). */
  _renderInstruments() {
    const song = this.selected;
    const avail = this.instrumentsOf(song);
    show($('#instrument-section'), avail.length > 0);
    const box = $('#instruments');
    box.innerHTML = '';
    if (!avail.length) return;
    const current = this.instrumentFor(song);
    for (const name of ['mix', ...avail]) {
      const b = document.createElement('button');
      b.textContent = instrumentLabel(name, avail);
      b.dataset.inst = name;
      b.classList.toggle('active', name === current);
      b.addEventListener('click', () => {
        this.settings.instrument = name;
        store.set('instrument', name);
        this._renderSongList();
      });
      box.appendChild(b);
    }
    // Picking an instrument starts decoding its stems now, so Play is quick.
    if (current !== 'mix') this._loadStems(song);
  }

  _renderSongList() {
    const list = $('#song-list');
    list.innerHTML = '';
    for (const song of this.songs) {
      const b = document.createElement('button');
      b.className = 'song' + (song === this.selected ? ' active' : '');
      const inst = this.instrumentFor(song);
      const notes = this.notesFor(song, this.settings.mode, this.settings.difficulty, inst).length;
      const best = store.get(this._bestKey(song, this.settings.mode, this.settings.difficulty, inst), 0);
      const parts = this.instrumentsOf(song).length;
      b.innerHTML = `
        <span class="song-title"></span>
        <span class="song-meta"></span>`;
      if (song.onRemove) {
        const x = document.createElement('span');
        x.className = 'song-remove';
        x.title = 'Remove song';
        x.textContent = '×';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          song.onRemove();
          this.removeSong(song);
        });
        b.appendChild(x);
      }
      b.querySelector('.song-title').textContent = song.chart.title;
      const instText = inst === 'mix' ? '' : ` · ${instrumentLabel(inst, this.instrumentsOf(song))}`;
      b.querySelector('.song-meta').textContent =
        `${song.chart.artist} · ${Math.round(song.chart.bpm)} BPM${instText} · ${notes} notes${best ? ` · best ${best.toLocaleString()}` : ''}`;
      if (parts) {
        const tag = document.createElement('span');
        tag.className = 'song-tag';
        tag.textContent = `${parts} instrument${parts > 1 ? 's' : ''}`;
        b.appendChild(tag);
      } else if (song.canSplit && this.onSplit) {
        const split = document.createElement('span');
        split.className = 'song-split';
        split.title = 'Split this song into drums, bass, vocals and lead so you can play any of them';
        split.textContent = 'Split into instruments';
        split.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onSplit(song);
        });
        b.appendChild(split);
      }
      b.addEventListener('click', () => { this.selected = song; this._renderSongList(); });
      list.appendChild(b);
    }
    this._renderInstruments();
  }
}
