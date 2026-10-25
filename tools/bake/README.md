# Lightmap baker (baked sky occlusion, no Blender)

The "COD Mobile trick": precompute the expensive, static part of the lighting offline and sample
it for the price of one texture fetch at runtime. We bake **sky visibility / ambient occlusion**
for the static map geometry of one map size (currently Plac Defilad › **Market**) with our own
ray caster — the same Rapier world the game collides with.

```sh
pnpm bake                                     # Plac Defilad, Market (default)
pnpm bake --map defilad --size market --samples 64 --workers 8
pnpm bake --out C:/tmp/trial-bake             # trial bake: PNGs + both manifests go there, repo untouched
```

Re-bake whenever the Market geometry changes (buildings, props, cover fill, wrecks, trees).
What happens until you do depends on what changed:

- **Layout or texture-size mismatch** (faces added, removed or resized): the game skips the bake
  with a `console.warn` and renders the map unbaked, exactly as before. The `bundled bakes` test in
  `packages/shared/src/maps/lightmap.test.ts` **fails** (a silently dropped bake must not ship).
- **Scene-hash-only mismatch** (occluders changed, faces didn't): the game keeps the bake and warns
  that it is stale (AO near the change may be off). The test only warns, so `pnpm check` stays
  green.

**Only the lead re-bakes, on `main`, after merging the lanes that change Market geometry.** Lanes
never commit re-baked PNGs or `lightmapManifest.ts`: they are generated/binary files that cannot be
merged by hand, so two lanes re-baking always conflict. A lane whose change breaks the layout hash
says so in its report; the lead merges it and re-bakes.

## Output

| File                                                          | What                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/client/public/lightmaps/defilad-market-atlas.png`   | 2048 × 1564 8-bit grey: one rect per wall/roof/prop face      |
| `packages/client/public/lightmaps/defilad-market-ground.png`  | 592 × 568 8-bit grey: top-down projection of the street level |
| `packages/client/public/lightmaps/defilad-market-lamps.png`   | atlas layout: ceiling-lamp irradiance on static faces (√)     |
| `packages/client/public/lightmaps/defilad-market-lampvol.png` | lamp irradiance volume for dynamic objects (see below)        |
| `packages/client/public/lightmaps/manifest.json`              | map, size, layout hash, scene hash, texture sizes             |
| `packages/shared/src/maps/lightmapManifest.ts`                | the same manifest, bundled (see "Runtime" below)              |

Current Market bake: **~430 KiB total** (301 KiB atlas + 130 KiB ground), 7066 faces, 2.8 M
texels × 64 rays ≈ 180 M rays, **~45–60 s** on the 16-thread dev machine (14 workers). Output is
byte-for-byte reproducible (fixed Hammersley pattern + per-texel integer hash rotation, fixed job
split independent of `--workers`).

## How it works

1. **Layout** (`packages/shared/src/maps/lightmap.ts`, pure, runs identically in Node and the
   browser). Every rendered face of every static box and convex prism near the play area (bounds
   - 6 m) gets a rectangle in one atlas at **0.25 m/texel** (faces longer than 64 m get coarser
     texels, capped at 256 texels a side, so ≤ 0.38 m/texel on the Market), packed tallest-first into
     2048-wide shelves with a 1-texel gutter. Planar faces of convex prisms make unwrapping trivial:
     walls use (edge, up), caps use the minimum-area edge-aligned rectangle. The street slab tops
     and every ground marking share one **top-down ground projection** (bounds + 8 m), so
     overlapping flats stay seamless. Faces outside the region map to a reserved white texel. The
     layout is hashed (mm-quantised) — the PNGs are only valid for that hash.
2. **Bake** (`lightmapBake.ts` + `bake.ts`). The baker builds a `PhysicsWorld` from the _rendered_
   static geometry (`bakeOccluders`: non-colliding visible props shade too; invisible collision
   bounds/ramps don't; tree trunks do, crowns/foliage don't). Per texel centre (offset 3 cm off the
   face): if the point is inside solid geometry the texel is _buried_ (no rays); otherwise 64
   cosine-weighted hemisphere rays out to 16 m, each contributing `hitDistance / 16` (1 if it
   escapes) — contact is black, a wall 16 m away barely shades. Then a 3 × 3 denoise over valid
   texels, dilation of valid values into buried texels (so bilinear filtering at face edges never
   pulls in "inside the wall" black), gutters filled by edge repeat, the ground border feathered
   to white (clamp-to-edge). Work is spread over `worker_threads`.
3. **PNG** (`lightmapPng.ts`): tiny greyscale encoder (per-row best PNG filter + `node:zlib`).

## Runtime (`packages/client/src/render/mapMesh.ts`)

- At map build (synchronous, before `Game.warmUp`) the bundled manifest is matched by map name and
  the layout is recomputed; a layout-hash or texture-size mismatch skips the bake with a
  `console.warn`. A scene-hash mismatch (occluders changed but faces didn't) keeps it and warns
  that it is stale.
- The same merged buckets get a `uv1` attribute and an **`aoMap` variant** of their material via
  `materials.variant(...)` (channel 1). No extra draw calls; concealment/foliage untouched.
- The map is built with its plain materials and loads nothing. `setBakedLighting(root, true)`
  (the Game's first quality pick on Medium+, or the first Low → Medium crossing) swaps the aoMap
  variants in and starts fetching + decoding the PNGs into textures that are white until then.
  `Game.create` awaits them (`bakedLightingReady`, bounded by `LIGHTMAP_LOAD_TIMEOUT_MS`) and
  uploads them with `renderer.initTexture` **before** `warmUp`, so no decode or upload lands
  mid-match. On timeout the loads are aborted with one `console.warn` and the map stays unbaked
  (white) for the session. A Low session never downloads, decodes or holds the lightmaps.
- Geometry emitted into a baked bucket that the layout does not enumerate (a new map feature
  `buildLightmapLayout` doesn't know yet) renders unbaked (atlas white texel / ground projection)
  with one `console.warn` per build; it never throws.
- three.js applies `aoMap` to **indirect light only** (hemisphere fill + IBL); the sun and its
  realtime shadows are unchanged. Strength: `BAKED_AO_INTENSITY` (0.85) in `mapMesh.ts` — a
  runtime knob, no re-bake needed.
- **Medium and up only.** Low keeps its exact pre-bake materials (`setBakedLighting`, swapped in
  `Game.setQuality` when crossing Low, where every program is rebuilt anyway).

## Limits / not done

- One map size (Market). Another size = `pnpm bake --size north` (atlas height grows; the layout
  refuses > 4096 rows). The full map would need several atlases or a coarser texel.
- Sky occlusion only: no baked sun visibility (realtime shadow maps already cover the sun), no
  bounce colour. A second channel for sun visibility would need a custom shader hook (materials
  lane) rather than `aoMap`.
- Dynamic things (players, grenades, drones, foliage) are neither baked nor occluders. They
  receive the ceiling lamps through the lamp volume (below), not sky occlusion: indoors they are
  still lit by the full outdoor IBL.

## Lamp volume (dynamic objects)

`shared/maps/lampVolume.ts` (layout, encoding, validation) + `lightmapBake.bakeLampVolume`.

- **Grid:** one box over every fixture's reach (± 8 m sideways, 6 m below, padded by a dark
  voxel), at the finest of 0.5 / 0.75 / 1 m that fits 393 216 voxels and 256 a side. Market:
  128 × 19 × 108 at 0.75 m (≈ 262 k voxels, 1 MiB on the GPU, **39 KiB PNG**, ~30 s of the bake).
- **Voxel:** the same emitter maths as the atlas lamps (each fixture a downward Lambertian area
  light, 4 × 4 jittered points, a shadow ray each), stored as L1 irradiance: a = Σw/4 and
  v = Σw·l/2, read as E(n) = clamp(a + v·n, 0, 3a) (lit tops, dark undersides). Buried voxels:
  two rings filled from open neighbours (floor-level light survives filtering), then the outer
  shell zeroed (clamp-to-edge reads dark outside).
- **File:** `<bake>-lampvol.png`, greyscale, the four planes (a, vx, vy, vz) stacked vertically
  (nx × 4·ny·nz); a linear, v signed around 128. Manifest `volume` = file, hash (grid + emitters),
  cell, min, nx/ny/nz. Optional: older bakes load without it. `selectLampVolume` drops a stale
  one (lamps moved/added/removed) with one warning and keeps the rest of the bake; the
  `bundled bakes` test fails on a shipped stale volume.
- **Runtime** (`client/render/lampLight.ts`): one shared `Data3DTexture` (sized at map build,
  zero until the PNG is decoded with the other lightmaps and filled in place). `applyLampVolume`
  patches the lit materials of soldiers, remote figures, the sparring partner, pickups, boards and
  hero models (sample at the fragment's world position) and the whole viewmodel scene (sample at
  the world camera, normals through the world camera's view matrix), before warm-up. One 3D fetch
  per fragment, added to the indirect diffuse after the aoMap with `LAMP_INTENSITY`/`LAMP_COLOR`.
  Compiled out on Low (`#ifndef TONE_MAPPING`: only Low tone-maps in the material), so Low keeps
  its programs; Medium+ programs are the variants warm-up already compiles.
- Rapier can panic on a ray that starts inside some convex hulls; buried texels cast no rays for
  that reason, and any ray that still traps is counted as blocked and the world rebuilt (the
  baker reports "N trapped rays"; 0 on the Market).
