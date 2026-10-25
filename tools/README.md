# tools/

Asset pipeline scripts (from M2):

- `osm/` — Overpass API fetch of building footprints for the Plac Defilad block.
- `blender/` — bpy scripts: extrude and clean footprints, export glTF.
- `gltf/` — gltf-transform: Draco/Meshopt, KTX2, instancing, LOD.

Perf probes:

- `render-budget-check.mjs` — portable CPU regression harness using Node and the installed
  TypeScript compiler: `node tools/render-budget-check.mjs`. Checks opaque concealment,
  foliage tiers and warm-up permutations, Low lighting/fog, and shadow shader hooks. It does
  not measure GPU performance.
- `perf-probe.mjs` — real-browser frame-time probe. Run `pnpm dev`, then `pnpm perf`. Defaults to
  the Defilad Market at `1600x900`, measuring `Low100` and `Auto60+` across alley, forecourt, and
  palace views in sunny weather. Set `WD_VIEW=alley|forecourt|palace|all`, `WD_WIDTH`,
  `WD_HEIGHT`, `WD_WEATHER=rain`, or `WD_ISOLATE=1` for the working foliage debug hide cut. The
  probe reports shader-program growth and target outcomes for Low100 (>=45 fps) and Auto60+
  (>=58 fps at >=0.60 scale).
