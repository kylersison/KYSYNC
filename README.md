# KySync

A keyboard rhythm game built in the browser on the Web Audio API, with two modes:

- **Drum** (Taiko-style): notes scroll into a drum. **F / J** hit the center (red *don*), **D / K** hit the rim (blue *ka*). Big notes: hit both keys of that color together for double points. Yellow drumrolls: hit as fast as you can.
- **Highway** (Fortnite Festival-style): five lanes on **D F J K L** scrolling down a perspective highway, with hold notes.

Add any song from your computer and KySync charts it automatically.

## Run it

```bash
npm install
npm run dev      # open the printed localhost URL
npm test         # judge + chart logic tests (Node, no browser)
npm run build    # static build in dist/
```

A demo song ("Pentatonic Rush") is synthesized in the browser, so the game works with no audio files.

## Adding songs

Menu → **+ Add a song** → pick an MP3, WAV, M4A or OGG. KySync analyzes it in the background (a few seconds) and builds Easy–Expert charts for both modes. Songs are saved in your browser (IndexedDB), so they're still there after a reload; remove one with the × on its card.

Name files `Artist - Title.mp3` to get the artist and title filled in.

How auto-charting works (`src/analysis.js`):
1. Short-time FFT → spectral flux: how much new sound appears every ~12 ms, split into low (kick, bass) and high (snare, hats, claps) bands.
2. Tempo from autocorrelation, then BPM and beat phase fine-tuned against the whole song, weighted toward bass hits so the grid locks onto the downbeat.
3. Onsets snapped to a 16th-note grid; the strongest become notes.
4. Drum: bass-heavy hits → don, bright hits → ka, strongest downbeats → big notes, long 16th runs → drumrolls. Highway: lane by brightness.

It assumes a steady tempo, so studio-recorded pop, rock, EDM and J-pop work best; live recordings or songs with tempo changes will drift.

## Playing an instrument (drums, bass, vocals, lead…)

Songs can be split into instrument **stems**, and each stem gets its own chart. Pick one under **Instrument** in the menu and you play just that part, in either mode: every stem plays together, and yours drops out while you miss notes and comes back when you hit (like Rock Band / Fortnite Festival). The demo song has drums, bass and lead stems built in, so you can try it right away.

Two ways to get stems:

1. **Split in the browser:** click **Split into instruments** on a song's card. KySync runs Meta's Demucs model (`htdemucs`, via ONNX Runtime Web on WebGPU) right in the page and gives you drums, bass, vocals and lead. The first time it downloads the model (~180 MB, then cached in the browser). With WebGPU (recent Chrome/Edge) it takes a minute or two per song; without it, it runs on the CPU and can take 10–40 minutes.
2. **Import stems made elsewhere:** **+ Add stems** → pick a folder. Files are matched by name (`vocals`, `drums`, `bass`, `other`, `guitar`, `piano`; `instrumental`/`no_vocals` counts as other), and any other audio file in the folder is used as the full song. The folder name becomes the title, so `Artist - Title/` works. Picking a folder of song folders adds them all.
   - `tools/split_stems.py` runs Demucs on your own computer with the 6-stem model, which adds **guitar** and **keys**:
     ```bash
     conda install -c conda-forge ffmpeg   # once
     pip install demucs                     # once
     python tools/split_stems.py "Artist - Title.mp3"
     ```
     Then **+ Add stems** → `stems/Artist - Title`. Ultimate Vocal Remover, Moises etc. work too.

How instrument charts work (`src/instrumentChart.js`, `src/pitch.js`), all on the beat grid found in the full song:
- **Drums:** the same hit charter as the full song, on isolated drums, so kick vs snare/hats (don vs ka) is much cleaner.
- **Bass, guitar, keys, lead:** onsets from the stem; lane from pitch, relative to the notes around it (a higher note moves right, a repeated note stays put). Bass uses YIN pitch tracking; chordy parts use harmonic summation to find the strongest note. Notes that ring become holds.
- **Vocals:** pitch tracked every 16 ms, cut into sung notes where the pitch moves or the singer breathes, snapped to 16ths. Long notes are holds.
- An instrument that's barely in the song (under ~10% of the beats) isn't offered.

Stems are stored in the browser as Opus (WebCodecs, ~4 MB per stem for a 4-minute song), or 16-bit PCM where WebCodecs audio isn't available.

## Themes

Menu → **Theme** (top right). Pick a preset (**Washi**, the dimmer **Lamplight**, dark **Sumi**, **Yoru** and **Matcha**, or **High contrast**), then change any color: background, highway, keys and panels, text, accent, missed notes, each lane, and the drum colors. **Brightness** dims the whole screen and **Paper texture** turns the grain down or off, both easy on the eyes for long sessions. **Mountains** are sumi-e ink ridges drifting slowly along the bottom of the screen (on by default; turn them off or fade them, and the choice sticks across themes). The game keeps playing preview notes behind the panel so you can see changes live; hold your lane keys to see pressed keys.

Edits are saved automatically. **Save this theme** adds it to your list, **Copy code** / **Import code** share a theme as text. Presets live in `src/themes.js`.

## Pausing

`Esc` pauses. Resuming rewinds 3 seconds and counts 3-2-1 while the song plays back up to where you stopped, so you can catch the beat before notes count again. Keys do nothing until the count hits zero. Change the length with `RESUME_COUNTDOWN` in `src/constants.js`.

Spotify can't be used as a source: it doesn't let apps access audio, and ripping streams breaks its terms. Use audio files you own.

## Controls

| Key | Drum mode | Highway mode |
| --- | --- | --- |
| `D` / `K` | Rim (ka), left / right | Lanes 1 / 4 |
| `F` / `J` | Center (don), left / right | Lanes 2 / 3 |
| `L` | – | Lane 5 |
| `Esc` | Pause / resume (3-2-1 countdown) | |
| `R` | Restart | |
| `Enter` | Play (menu), retry (results) | |

**Calibrate before judging the feel.** Every setup (speakers, Bluetooth headphones, keyboard) has different latency. The calibration screen plays clicks; tap Space on each one and the game saves your offset. The results screen also tells you if you're consistently early or late.

## How timing works

- The song clock comes from the `AudioContext`, not from frames or `setTimeout`. `AudioEngine.now()` uses `getOutputTimestamp()` so "now" is the sample you're actually hearing.
- Key presses are judged at `event.timeStamp` (when the key went down), converted onto the audio clock, minus your calibration offset.
- Hit windows: Perfect ±40 ms, Great ±80 ms, Good ±120 ms. Pressing early with no note in range does nothing (no penalty). In drum mode, hitting the wrong drum while a note is in range counts as a miss.
- Combo raises the multiplier every 10 notes, up to ×4. Holds add points per second while held; releasing early stops sustain points but keeps your combo.

All of these numbers live in `src/constants.js`.

## Project structure

```
src/
  constants.js    keys, colors, hit windows, scoring
  audio.js        AudioEngine: game clock, playback, pause
  judge.js        highway hit detection, scoring, combo (pure logic, unit tested)
  drumJudge.js    drum mode: don/ka, big notes, drumrolls
  chart.js        chart format, drum conversion, auto-generated easier difficulties
  analysis.js     auto-charting from audio (FFT, tempo, onsets)
  instrumentChart.js  per-instrument charts from stems (drums, pitched parts, vocals)
  pitch.js        pitch detection (YIN, harmonic summation) and pitch → lane mapping
  analysis.worker.js  runs analysis off the main thread
  stems.js        splitting in the browser (Demucs) and importing stem files
  stemCodec.js    stores stems compactly (Opus via WebCodecs, PCM fallback)
  library.js      saved songs (IndexedDB)
  theme.js        live colors (THEME etc.), paper texture, keycap drawing
  themes.js       theme presets, saved themes, applying a theme to canvas + CSS
  themePanel.js   the Theme screen (presets, color pickers, brightness, texture)
  renderer.js     highway mode canvas
  drumRenderer.js drum mode canvas
  calibration.js  latency calibration
  demoSong.js     procedural demo chart + synthesized audio
  game.js         state machine, input, menu/results UI
  main.js         bootstrap
charts/example.json   chart format example
tools/split_stems.py  Demucs on your own computer (6 stems: adds guitar + keys)
tests/                node --test
```

## Chart format

```json
{
  "title": "Song",
  "artist": "Artist",
  "bpm": 120,
  "offset": 0.0,
  "notes": [
    { "time": 2.0, "lane": 0 },
    { "time": 4.0, "lane": 4, "duration": 1.0 }
  ]
}
```

- `time` and `duration` are seconds from the start of the audio file. `lane` is 0–4 (D–L).
- `offset` is where beat 1 lands, used for beat lines and difficulty generation.
- `notes` is treated as Expert; Easy, Medium and Hard are generated automatically. To hand-author them instead, use `"difficulties": { "easy": [...], "expert": [...] }`.
- Drum mode reads an optional `"drum"` list: `{ "time": 2.0, "type": "don" }` where `type` is `don`, `ka`, `bigDon`, `bigKa` or `roll` (rolls take a `duration`). Without it, the drum chart is converted from `notes`.
- Instrument charts go under `"instruments": { "drums": { "notes": [...], "drum": [...] }, "bass": {...}, "vocals": {...} }`, each with the same fields as the top level. Instruments are `drums`, `bass`, `guitar`, `piano`, `other`, `vocals`.

To use a hand-made chart: menu → **Use a hand-made chart instead** → pick the JSON, then **+ Add a song** with its audio.

## Roadmap

- [x] **Step 1:** highway, input, hit detection, holds, scoring, demo song
- [x] **Step 2:** latency calibration, results screen, best scores
- [x] **Step 3:** auto-charting from an uploaded audio file
- [x] **Drum mode** (Taiko-style) alongside the highway
- [ ] Chart editor to fix auto-charted notes
- [x] Instrument tracks via stem separation (drums / bass / vocals / lead, plus guitar / keys from 6-stem Demucs)
- [x] 3-2-1 countdown after unpausing
- [ ] Spotify search + metadata (album art, playlists); audio still comes from the player's own files

