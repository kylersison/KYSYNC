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

Spotify can't be used as a source: it doesn't let apps access audio, and ripping streams breaks its terms. Use audio files you own.

## Controls

| Key | Drum mode | Highway mode |
| --- | --- | --- |
| `D` / `K` | Rim (ka), left / right | Lanes 1 / 4 |
| `F` / `J` | Center (don), left / right | Lanes 2 / 3 |
| `L` | – | Lane 5 |
| `Esc` | Pause / resume | |
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
  analysis.worker.js  runs analysis off the main thread
  library.js      saved songs (IndexedDB)
  theme.js        washi paper, colors, keycap drawing
  renderer.js     highway mode canvas
  drumRenderer.js drum mode canvas
  calibration.js  latency calibration
  demoSong.js     procedural demo chart + synthesized audio
  game.js         state machine, input, menu/results UI
  main.js         bootstrap
charts/example.json   chart format example
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

To use a hand-made chart: menu → **Use a hand-made chart instead** → pick the JSON, then **+ Add a song** with its audio.

## Roadmap

- [x] **Step 1:** highway, input, hit detection, holds, scoring, demo song
- [x] **Step 2:** latency calibration, results screen, best scores
- [x] **Step 3:** auto-charting from an uploaded audio file
- [x] **Drum mode** (Taiko-style) alongside the highway
- [ ] Chart editor to fix auto-charted notes
- [ ] Instrument tracks via stem separation (drums / bass / vocals / lead)
- [ ] Spotify search + metadata (album art, playlists); audio still comes from the player's own files

