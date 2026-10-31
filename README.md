# KySync

A keyboard rhythm game in the style of Fortnite Festival, built in the browser on the Web Audio API.

Five lanes, played with **D F J K L**. Notes scroll down a perspective highway; hit them as they cross the line, hold the key for sustain notes.

## Run it

```bash
npm install
npm run dev      # open the printed localhost URL
npm test         # judge + chart logic tests (Node, no browser)
npm run build    # static build in dist/
```

A demo song ("Pentatonic Rush") is synthesized in the browser, so the game works with no audio files. Each lane is one pitch of a pentatonic scale, so every note you hit is a sound you hear.

## Controls

| Key | Action |
| --- | --- |
| `D` `F` `J` `K` `L` | Hit lanes 1–5 |
| `Esc` | Pause / resume |
| `R` | Restart |
| `Enter` | Play (menu), retry (results) |

**Calibrate before judging the feel.** Every setup (speakers, Bluetooth headphones, keyboard) has different latency. The calibration screen plays clicks; tap Space on each one and the game saves your offset. The results screen also tells you if you're consistently early or late.

## How timing works

- The song clock comes from the `AudioContext`, not from frames or `setTimeout`. `AudioEngine.now()` uses `getOutputTimestamp()` so "now" is the sample you're actually hearing.
- Key presses are judged at `event.timeStamp` (when the key went down), converted onto the audio clock, minus your calibration offset.
- Hit windows: Perfect ±40 ms, Great ±80 ms, Good ±120 ms. Pressing early with no note in range does nothing (no penalty).
- Combo raises the multiplier every 10 notes, up to ×4. Holds add points per second while held; releasing early stops sustain points but keeps your combo.

All of these numbers live in `src/constants.js`.

## Project structure

```
src/
  constants.js    keys, colors, hit windows, scoring
  audio.js        AudioEngine: game clock, playback, pause
  judge.js        hit detection, scoring, combo (pure logic, unit tested)
  chart.js        chart format + auto-generated easier difficulties
  renderer.js     canvas highway, notes, HUD
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

To play your own song: menu → **Load your own song** → pick an audio file and a chart JSON.

## Roadmap

- [x] **Step 1:** highway, input, hit detection, holds, scoring, demo song
- [x] **Step 2:** latency calibration, results screen, best scores
- [ ] **Step 3:** auto-charting from an uploaded audio file (onset + beat detection, lanes by pitch/frequency band)
- [ ] **Step 4:** instrument tracks via stem separation (drums / bass / vocals / lead), chart editor
- [ ] **Step 5:** Spotify search + metadata (album art, playlists); audio still comes from the player's own files

## About Spotify

Spotify doesn't give apps access to audio files, and ripping streams breaks its developer terms. Its audio-analysis endpoints were also shut off for new apps in November 2024. So KySync plays audio files the player supplies; Spotify can only be used for things like search and metadata.
