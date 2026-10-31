// Game: state machine, input, and menu/results UI wiring.
// States: menu → loading → playing ⇄ paused → results, plus calibrate.
// Modes: 'drum' (Taiko-style, D F J K) and 'highway' (5 lanes, D F J K L).

import { LANE_COUNT, LANE_KEYS, DIFFICULTY_ORDER, LEAD_IN } from './constants.js';
import { AudioEngine } from './audio.js';
import { Judge } from './judge.js';
import { Renderer } from './renderer.js';
import { DrumJudge } from './drumJudge.js';
import { DrumRenderer } from './drumRenderer.js';
import { Calibration } from './calibration.js';

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
      speed: store.get('speed', 1.5),
      offsetMs: store.get('offsetMs', 0),
    };
    this.state = 'menu';
    this.keysDown = new Array(LANE_COUNT).fill(false);
    this.judge = null;
    this.song = null;
    this.playMode = this.settings.mode; // mode of the song in progress
    this.duration = 0;
    this.calibration = null;

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

  notesFor(song, mode = this.settings.mode, diff = this.settings.difficulty) {
    return mode === 'drum' ? song.chart.drum[diff] : song.chart.difficulties[diff];
  }

  get offsetSec() {
    return this.settings.offsetMs / 1000;
  }

  get lookahead() {
    return 1.6 / this.settings.speed;
  }

  // ---------- flow ----------

  async start() {
    if (this.busy || !this.selected) return;
    this.busy = true;
    this.engine.ensure(); // unlock audio inside the user gesture
    const song = this.selected;
    try {
      if (!song.buffer) {
        this.setLoading('Loading song…');
        song.pending ??= song.load(this.engine); // may already be preloading
        song.buffer = await song.pending;
      }
      this.song = song;
      this.playMode = this.settings.mode;
      const notes = this.notesFor(song);
      this.judge = this.playMode === 'drum' ? new DrumJudge(notes) : new Judge(notes);
      this.duration = song.buffer.duration;
      this.keysDown.fill(false);
      this.engine.play(song.buffer, LEAD_IN);
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
    if (this.state !== 'playing') return;
    this._releaseAll();
    await this.engine.pause();
    this._setState('paused');
  }

  async resume() {
    if (this.state !== 'paused') return;
    this._setState('playing');
    await this.engine.resume();
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
    const key = `best.${this.playMode}.${this.song.id}.${this.settings.difficulty}`;
    const prevBest = store.get(key, 0);
    const score = Math.floor(j.score);
    if (score > prevBest) store.set(key, score);

    $('#r-grade').textContent = gradeLetter(j.accuracy);
    $('#r-title').textContent = `${this.song.chart.title} · ${this.playMode} · ${this.settings.difficulty}`;
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

  _loop() {
    requestAnimationFrame((ts) => this._loop(ts));
    const inGame = this.state === 'playing' || this.state === 'paused';
    let t;

    if (inGame) {
      t = this.engine.now();
      if (this.state === 'playing') {
        this.judge.update(t - this.offsetSec);
        const done = this.judge.isFinished() && t > this.judge.lastNoteEnd + 1.5;
        if (done || t > this.duration + 0.25) this._finish();
      }
    } else {
      t = performance.now() / 1000; // idle background scroll
    }

    const mode = inGame ? this.playMode : this.settings.mode;
    const r = this.renderers[mode];
    // Each frame starts from a clean canvas state, so one bad frame can't leave a clip
    // or transform behind for the next (that's what shrank the highway before).
    r.g.save();
    try {
      r.draw({
        t,
        judge: inGame ? this.judge : null,
        lookahead: inGame ? this.lookahead : 1.4,
        keysDown: this.keysDown,
        bpm: inGame ? this.song.chart.bpm : 90,
        offset: inGame ? this.song.chart.offset : 0,
        beats: inGame ? this.song.chart.beats : null,
        barPhase: inGame ? this.song.chart.barPhase : 0,
        duration: this.duration,
        title: this.song?.chart.title,
        difficulty: this.settings.difficulty,
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
      if (this.state === 'playing') this.pause();
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
    for (const b of document.querySelectorAll('#diffs button')) {
      b.classList.toggle('active', b.dataset.diff === s.difficulty);
    }
    for (const b of document.querySelectorAll('#modes button')) {
      b.classList.toggle('active', b.dataset.mode === s.mode);
    }
    for (const el of document.querySelectorAll('[data-for-mode]')) {
      show(el, el.dataset.forMode === s.mode);
    }
  }

  _renderSongList() {
    const list = $('#song-list');
    list.innerHTML = '';
    for (const song of this.songs) {
      const b = document.createElement('button');
      b.className = 'song' + (song === this.selected ? ' active' : '');
      const notes = this.notesFor(song).length;
      const best = store.get(`best.${this.settings.mode}.${song.id}.${this.settings.difficulty}`, 0);
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
      b.querySelector('.song-meta').textContent =
        `${song.chart.artist} · ${Math.round(song.chart.bpm)} BPM · ${notes} notes${best ? ` · best ${best.toLocaleString()}` : ''}`;
      b.addEventListener('click', () => { this.selected = song; this._renderSongList(); });
      list.appendChild(b);
    }
  }
}
