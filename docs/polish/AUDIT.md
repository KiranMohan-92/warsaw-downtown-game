# Market visual audit (lane polish, 2026-10-02/03)

Bar: Call of Duty: Mobile–level image quality in the browser (quality only), at 50–60 fps on the
Intel UHD iGPU. Scope frozen: presentation only, Market map, no gameplay/concealment/collision
changes. The truck, tank and helicopter wrecks belong to the vehicle lanes and are left out here.

Sheet: 11 fixed poses (`tools/_pl_shots.mjs`, local), 1280×720, sunny, HUD on: **High on the
NVIDIA T2000** (`WD_DGPU=1`) and **Low on the Intel UHD**. Images live in the lane's scratch
directory (not the repo); before = `base-*`, after = `lane-*`. Graded from 1:1 crops, not just the
downscaled sheet.

## Grading sheet (before the lane)

Scores out of 10 against the CoD Mobile bar (High / Low).

| View                       | High | Low | What reads wrong                                                                                                                                                |
| -------------------------- | ---- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plaza toward the Palace    | 4    | 3.5 | Flat beige Palace massing; **portico ceiling shows a row of black "window" squares**; tile-like grey paving; flat light. Low: no grade/vignette, flatter still. |
| Stalls                     | 5.5  | 5   | Props are good (cartons, chests); lawn is flat; stalls are boxy.                                                                                                |
| Maze alley                 | 5    | 4.5 | Containers and hedge fine; ground flat; little atmosphere.                                                                                                      |
| Forecourt under the Palace | 3    | 3   | **Black squares all over the soffit/coffers** (on every tier).                                                                                                  |
| Container area             | 6    | 5.5 | Best view: rust, wear, stencils hold up.                                                                                                                        |
| Tall grass close-up        | 3    | 3   | **The core reads as a dark wall** behind the lit blades.                                                                                                        |
| Hedge close-up             | 5    | 4.5 | Scan leaf texture reads; crown edge facets; dark overall.                                                                                                       |
| Sandbags                   | 4    | 4   | **Flat-sided "loaves"**: 8-sided prism bodies, facets within ~2 m.                                                                                              |
| Hall interior              | 4.5  | 4   | Plain walls, flat ceiling; lamps OK.                                                                                                                            |
| Fight (dummies, firing)    | 3.5  | 3.5 | **Muzzle flash is a flat, untextured beige card**; tracers thin; impacts small.                                                                                 |

Overall before: **~4.3 / 10 (High), ~4 (Low)**.

## Ranked gaps (visible impact per fps cost)

| #   | Gap                                                                                                                              | Where                          | Expected cost (Low 100 %, iGPU)                                                                                               | Decision                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Muzzle flash = flat beige square                                                                                                 | every shot, every tier         | ~0 (same single draw, 32 KB texture)                                                                                          | **Fixed**                                                                                                 |
| 2   | Black "windows" on the Palace portico ceiling (facade prism caps took the painted facade texture's window grid)                  | plaza, forecourt, every tier   | 0 (existing stone bucket, no new draw)                                                                                        | **Fixed**                                                                                                 |
| 3   | Low shows the flat ungraded image (no saturation/contrast/vignette) while Medium+ are graded; Low is where Auto settles on iGPUs | everything on Low              | small ALU in the present pass that already runs (the exact sRGB round trip cost ~1.3 ms: replaced by a gamma-2 approximation) | **Fixed**                                                                                                 |
| 4   | Tall-grass core is a dark wall up close                                                                                          | every clump                    | 0 (vertex shade)                                                                                                              | **Fixed**                                                                                                 |
| 5   | Sandbag facets / flat-sided loaves                                                                                               | every sandbag wall within 40 m | +16 tris/bag near LOD (64 → 80)                                                                                               | **Fixed** (a 140-tri version cost 0.3–1.1 ms: cut back)                                                   |
| 6   | Lighting / colour / atmosphere (flat midday, weak contrast between sun and shade, no aerial perspective)                         | everything                     | 0–0.3 ms for a re-grade / haze tune                                                                                           | Deferred: taste call for Kiran, and shade brightness changes how visible players are in shadow (fairness) |
| 7   | Impact VFX (one small radial spark sprite + debris)                                                                              | fights                         | ~0                                                                                                                            | Deferred (time); next after this lane                                                                     |
| 8   | Palace facade massing (flat beige blocks)                                                                                        | plaza                          | large (geometry/textures)                                                                                                     | Deferred: asset work, not a polish pass                                                                   |
| 9   | Paving reads as small grey bathroom tile                                                                                         | plaza, forecourt               | 0 (texture scale/colour)                                                                                                      | Deferred: `materials.ts` is shared with the rain lane                                                     |
| 10  | Ground grime: no crisp contact line (0.5 m mask)                                                                                 | everywhere                     | ~0.2 ms for a finer mask                                                                                                      | Deferred                                                                                                  |
| 11  | Hedge crown edge facets                                                                                                          | hedges up close                | small                                                                                                                         | Deferred (minor)                                                                                          |
| 12  | Tall-grass far LOD = bare domed core                                                                                             | > ~32 m                        | needs a cheap far blade layer                                                                                                 | Deferred                                                                                                  |
| —   | Decor (bags, bins) clipping into the burnt-car body: placed flush against the collision box, which is smaller than the model     | car wrecks                     | —                                                                                                                             | **Out of scope**: decor drives collision; for the lead / vehicle-art lane                                 |

## After the lane

| View                | High | Low | Change                                                 |
| ------------------- | ---- | --- | ------------------------------------------------------ |
| Plaza               | 5    | 4.5 | Portico ceiling is dressed stone; Low graded like High |
| Forecourt           | 5    | 5   | No more black squares                                  |
| Tall grass close-up | 4    | 4   | Core reads as dense grass, still a wall-like mass      |
| Sandbags            | 5    | 5   | Rounded, bulging sacks                                 |
| Fight               | 5    | 5   | Flame star + plumes, glows through bloom on Medium+    |

Overall after: **~5 / 10 (High), ~4.7 (Low)** — clearly better, still well short of CoD Mobile:
the gap is now mostly lighting/atmosphere and the Palace/ground materials (items 6, 8, 9), which
need Kiran's taste call or asset work.

## fps (Intel UHD 0x9BC4, 1600×900, sunny, headless, `tools/fps-probe.mjs` copy with a vsync-off switch)

Interleaved in one GPU-lock session: base = main d159255 (:5232), lane = this branch (:5231), two
rounds each. Views alley / stalls / forecourt.

|         | Low 100 % capped   | Low 100 % uncapped | Auto                      |
| ------- | ------------------ | ------------------ | ------------------------- |
| base r1 | 49.7 / 59.7 / 60.2 | 60.1 / 61.3 / 63.5 | 56.6 / 59.2 / 52.6 @ 0.60 |
| lane r1 | 55.9 / 58.9 / 58.4 | 62.4 / 61.9 / 62.2 | 58.0 / 60.1 / 60.2 @ 0.60 |
| base r2 | 54.2 / 55.3 / 55.7 | 60.1 / 62.4 / 63.7 | 60.2 / 59.3 / 60.2 @ 0.60 |
| lane r2 | 48.5 / 51.2 / 47.6 | 58.6 / 61.6 / 61.4 | 59.7 / 60.1 / 60.2 @ 0.60 |

Uncapped means: base 61.9, lane 61.4 fps (−0.5, inside the run-to-run noise; capped Low swings
±6 fps between identical runs). Triangles +26 k (alley) from the sandbags; draw calls −2.
Programs after warm-up and a full tour incl. firing: High 195 → 193, Low 176 → 174, stable.

The first lane build (exact sRGB grade + 140-tri bags) measured −8 to −10 fps in the same A/B;
see `loops/FAILURES.md`.
