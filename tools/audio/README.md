# tools/audio

Builds `packages/client/public/audio/*.ogg` + `manifest.json` from CC0 sources.

```bash
python tools/audio/process.py   # needs ffmpeg + numpy; py7zr only to unpack the firearm library
```

Raw downloads live in `tools/audio/raw/` (git-ignored). To rebuild from scratch, download these into it (all CC0 1.0, verified on each page 2026-09-26):

| File                                                                                               | Source                                                         |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `kenney_impact-sounds.zip` → unzip to `kenney_impact/`                                             | https://kenney.nl/assets/impact-sounds                         |
| `kenney_rpg-audio.zip` → unzip to `kenney_rpg/`                                                    | https://kenney.nl/assets/rpg-audio                             |
| `firearm_library.7z` (`Prepared SFX Library.7z`) → extract AR-15 + Walther PPQ WAVs to `firearms/` | https://opengameart.org/content/the-free-firearm-sound-library |
| `assaultriflereload1.wav`, `gunreload1.wav`                                                        | https://opengameart.org/content/gun-reload-sounds              |
| `equipment_clicks3.wav`                                                                            | https://opengameart.org/content/equipment-clicks-iii           |
| `amb_rain_loop_1.ogg`                                                                              | https://opengameart.org/content/amb-rain-loop-1                |
| `rain-thunder.ogg`                                                                                 | https://opengameart.org/content/rain-long-thunder              |
| `chunky_explosion.mp3`                                                                             | https://opengameart.org/content/chunky-explosion               |
| `yelling_sounds.zip` → unzip to `voices/` (HaelDB, CC0)                                            | https://opengameart.org/content/male-gruntyelling-sounds       |
| `breathing_tired.wav` (mikeask, CC0)                                                               | https://opengameart.org/content/breathing-tired                |
| `dynamite.wav`                                                                                     | https://opengameart.org/content/dynamite-sound-effect          |
| `muffled_distant_explosion.ogg`                                                                    | https://opengameart.org/content/muffled-distant-explosion      |

Processing: onset-trim (≤4 ms pre-attack), length cut + squared fade-out, peak-normalise to −1 dBFS (foley quieter), mono 48 kHz Ogg Vorbis q5; rain bed stereo q3 with a crossfaded loop seam; thunder cut around the loudest crack; equipment clicks split into the six strongest single clicks.
