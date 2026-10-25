# Skyline towers polish — 2026-10-20

The backdrop now uses one texture-free standard material with per-building metre-scale
window grids, varied warm/cool room tones and clear/satin/ribbon finishes. Original
floor bands and crowns remain; glass crown walls share their building's grid. Solid
concrete caps carry grey albedo explicitly. Facades, roofs and equipment share the
same shader and the existing static batch submission.

Golden-hour occupancy is 5.5%; dusk is 28%, neon 46%. Weather changes only update two
shared uniforms (intensity includes the preset exposure). Window coverage is box
filtered; unresolved random rooms converge to their mean instead of flickering.
Aerial perspective adds at most 4% haze through 160–420 m and another 8% through
420–850 m, combined with the existing fog. Fog still uses the horizon colour; the
approved golden sky, exposure, fog density and clouds are unchanged.

Selected flat crowns/roofs receive plant equipment, antennas, six-sided tanks or capped
crane stubs. Sloped crown tops deliberately carry no equipment. All dressing is
client-only and remains outside playable bounds; collision and bake layout are unchanged.

## Cost and verification

- 56,809 backdrop triangles on all map sizes, up 702 from 56,107; cap remains 60,000.
- No new textures, samplers for facade detail, per-frame allocations or per-window draws.
  The static four-float building attribute adds 1,816,592 bytes (about 1.73 MiB) per map.
- One shared material replaces the four original backdrop materials/buckets in the
  static batching path. With multi-draw: one backdrop submission; the extension fallback
  retains the original four ranges. All remain opaque and depth-pre-pass eligible.
- One shader recipe, with the existing Low tone-mapped/sRGB and Medium+ HDR variants.
  The map constructs everything before `Game.warmUp`, whose compile and draw paths
  cover both. Weather, roughness and building variation add no late program variants.
- Focused checks cover periodic coverage filtering, weather occupancy, haze bands,
  source/attribute stability, roof support, triangle limits, bake exclusion, shared
  material/key stability and unchanged golden-weather intent.

GPU timing and real driver program counts are **not measured in WSL**. Expected added
cost is small: the shader replaces three surface texture reads with bounded procedural
math and uses the existing depth pre-pass; backdrop geometry grows 1.25%. This is a design
budget, not proof of the +0.5 ms limit. Vitest needs the Windows gate because this
checkout lacks the Linux Rolldown native binding; the focused tests also run via a
temporary Node assertion adapter locally.

Local verification: workspace and client typechecks, ESLint, Prettier and 43 focused
assertions passed. The dependency audit could not reach npm (`EAI_AGAIN`); no dependency
or lockfile changes were made.

## Lead gate

Capture `skyline-north`, `skyline-east`, `skyline-south`, `skyline-southeast`, plus
`palace-tower_wide`, `palace-tower_top`, `palace-tower_from_forecourt` and
`palace-palace_from_stalls` using `tools/_laneShots.mjs` poses. Compare golden on Low
and High against `e2e/artifacts/survey-2026-10-20/`; check dusk/neon room lights and
sunny/overcast/rain fog/wetness. Move and turn to check thin grids for shimmer.

Run the full Windows `pnpm check`, program-count tour after warm-up/weather changes
and the Intel UHD Low/Auto / T2000 High GPU A/B at 1600×900. Require at most +0.5 ms
GPU on Low and the agreed 50–60 fps bar. No browsers were launched in this lane.
