# Visual-slice assets (CC0)

Downloaded with Kiran's approval on 2026-09-26 for the visual-quality slice (Market first). Raw
files live in `tools/assets/raw/` (git-ignored). Nothing here ships until it is processed
(resized, KTX2/Draco-compressed) and used by the game; at that point each shipped file is logged in
`ASSETS.md`.

```
python tools/assets/fetch_polyhaven.py --dry-run   # list + sizes
python tools/assets/fetch_polyhaven.py             # download (resumes; skips complete files)
```

Processing (Python + Pillow only; outputs are committed, logged in `ASSETS.md`):

```
python tools/assets/build_textures.py   # raw sets -> packages/client/public/tex/<surface>_{albedo,normal,rough}[_512].webp
python tools/assets/build_env.py        # raw HDRIs -> packages/client/public/env/<id>.hdr + manifest.json
python -m pytest tools/assets -q        # RGBE encode/decode, sun clamp/rotation, texture stats
```

Both accept `--raw DIR` (e.g. the main checkout's `tools/assets/raw/polyhaven` from a worktree;
`build_textures.py` wants the `textures` folder in it).
`build_textures.py` reads each surface's palette colour from `materials.ts` and bakes its hue and
brightness into the albedo (re-run it after changing a scanned surface's palette colour);
`CHROMA_KEEP` sets how much of a scan's own colour variation survives.
`build_env.py` box-filters each HDRI to 512 × 256 (PMREM cube 128, the same size as the procedural
sky bake, so swapping maps never recompiles a shader), inpaints the sun (the game's shadowed
DirectionalLight is the sun), rotates it to the weather preset's sun azimuth and normalises the upper
hemisphere to mean luminance 1 (the client scales it to the preset's sky brightness). HDRIs were
assigned by what they show: `palermo_square` = sunny, `dresden_square` = overcast, `potsdamer_platz`
= rain; dusk keeps the procedural sky (no dusk HDRI); `hansaplatz` (night) waits for a night preset.

Source: [Poly Haven](https://polyhaven.com) — every asset CC0 1.0. ≈ 190 MB raw (235 files).

| Group                      | Assets                                                                                                                                                                                                                                                          | Planned use                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Sky + lighting (2k HDRI)   | `dresden_square` (sunny), `potsdamer_platz` (overcast/rain), `palermo_square` (dusk), `hansaplatz` (night)                                                                                                                                                      | Image-based lighting and sky reflections per weather preset |
| Street surfaces (2k)       | `asphalt_02`, `square_concrete_pavers`, `granite_tile_04`                                                                                                                                                                                                       | Roads, pavements, Plac Defilad granite                      |
| Palace (2k)                | `large_sandstone_blocks`                                                                                                                                                                                                                                        | The Palace of Culture's sandstone cladding                  |
| Walls (1k)                 | `plastered_wall_05`, `concrete_wall_008`, `grey_plaster_02`                                                                                                                                                                                                     | Facades, market hall, underground                           |
| Props (1k)                 | `wood_planks`, `worn_corrugated_iron`, `metal_plate`, `rusty_painted_metal`, `leafy_grass`                                                                                                                                                                      | Crates/stalls, containers, metal, wrecks, lawns             |
| Models (glTF, 1k textures) | crates ×3, barrels ×2, concrete road barriers ×2, covered car, trash can, street lamps ×2, utility boxes ×2, street seating, bench, planters ×3, shrubs ×4, tyre, cardboard box, plastic crate, trash bag, power box, generator, chain-link fence, picnic table | Market dressing and cover                                   |

Not taken: Poly Haven's trees (`fir_tree_01` 487 MB, `tree_small_02` 101 MB) are film-grade and far
too heavy for a browser game; trees need game-ready models (or generated hero assets).

Gaps the free libraries don't cover at realistic quality — candidates for **Higgsfield** 3D generation
(paid; cost estimate to Kiran first): modern cars/vans, a city bus and tram, shipping containers
(real models vs. textured boxes), the helicopter and tank wrecks, market stalls with awnings, and
game-ready trees. The Palace's facade detail (pinnacles, pilasters, clock) is built in code.

## Market prop models

```
python tools/assets/build_models.py --raw tools/assets/raw/polyhaven/models
python tools/assets/build_prop_collision.py  # collision-only rebuild from committed glTFs
python -m unittest discover -s tools/assets -p 'test_models.py'
```

Shipped models are meshopt-packed: run `pnpm assets:pack` after any model build (a vitest fails on
unpacked models). Tools that read shipped meshes back (`build_prop_collision.py`, `build_fparms.py`)
go through `raw_models.raw_model`, which returns a freshly exported file as is, or decodes the packed
one to `tools/assets/build/unpacked/` (via `node tools/assets/meshopt_pack.mjs --unpack`) whenever
the shipped file is newer.

The Python/Pillow builder selects nodes, bakes transforms, simplifies meshes with a local
quadric-error reducer, recentres them and shares 512 px texture tiles in three padded WebP
atlases (albedo with AO, OpenGL normal, roughness/metalness). Low loads half-resolution atlases.
No additional tools/downloads are needed. `manifest.json` records the sources and triangle
budgets; `ASSETS.md` logs every source. The prop set is about 2.14 MB, below the 2.4 MB budget.
`--only` is for geometry-only edits: texture membership/order must stay fixed; rebuild the whole
set after changing model membership, transforms or atlas layout.

Shared `maps/propGeometry.gen.json` is derived from the reduced glTFs: welded positions and
indices, no render materials. Physics, fallback drawing, and the model renderer use the same
placement math in `shared/maps/propModels.ts`. Static triangle meshes preserve barrier tapers,
bin openings and tyre holes; Rapier fixes internal edge contacts. An interior query volume in
crates rejects contained capsules during spawn/traversal checks, but never blocks bullet rays
through slat gaps. The runtime verifies loaded triangles against the shared collision data and
versions asset URLs by the geometry hash. Cover boxes remain placement
envelopes, so the source scans fit their footprint/height but their actual surfaces determine hits.
The scene hash includes this geometry; the lead must rebake Market lighting after integration.

Only Market cover is tagged in the city map. Crates use one model per envelope; barrier runs tile
along their length. Dressing is deterministic, clears doors/stairs/foliage and keeps walking space.
All tiers use identical geometry. `render/propModels.ts` loads and uploads the assets before
`Game.warmUp`, then uses ordinary instancing per model in 256 m chunks. A load/timeout failure
keeps the untextured shared silhouettes and warns; no asynchronous model install occurs in play.

WSL verification uses the installed TypeScript/Prettier JS entry points. Full Vitest/lint and
browser/GPU checks run on the lead's Windows checkout; this lane starts no servers or ports.

Textures are WebP (`webp.py`, Pillow's libwebp): every builder calls `save_webp`. Builders that
encode from lossless intermediates pass `match_jpeg=<old JPEG quality>`, which picks the lowest
WebP quality whose PSNR is at least that JPEG's (never less faithful, 15-80 % smaller); alpha is
kept bit-exact (lossless alpha plane, colour under transparent texels kept) and tree impostor
normals are lossless. `python tools/assets/webp.py auto <files>` transcodes already-shipped
JPEG/PNG next to the source (q85 colour / q92 data, stepping down at most 7 when that would outgrow
the source). Exceptions: `models/arms/` (own lane) and `lightmaps/*.png` (8-bit data, lossless).

## Vehicles (lane vehicle-art)

```
python tools/assets/vehicle_texprep.py SRC OUT --sheet OUT/sheet.jpg      # heal + de-light texture sources
WD_VEH_SOURCES=OUT blender -b --python tools/assets/build_vehicles.py -- --only truck   # our own models
WD_VEH_SOURCES=OUT blender -b --python tools/assets/rebake_model.py -- --config CFG.json  # any glTF/FBX/OBJ
blender -b --python tools/assets/render_vehicles.py -- --models truck --out DIR          # review renders
```

`rebake_model.py` is model-agnostic: it imports a model, applies its transforms plus the config's
scale/yaw, maps source materials to palette kinds by name, splits and re-pivots the four wheels,
grounds the model between the axles (optionally fitting the contract wheelbase), unwraps one unique
atlas, bakes the layered-wear materials (`vehicle_mats.py`) onto it, writes near + far LODs, adds
the seat/exit empties and validates the truck contract (`vehicle_contract.py`; exit 2 on a
violation). The config format is in its docstring. `test_rebake_model.py` runs it on a tiny dummy
truck when Blender is installed (`WD_BLENDER`), else skips. Outputs go to the git-ignored
`tools/assets/build/vehicles/`; the texture sources stay out of the repo (`vehicle_textures.json`
keeps the prompts).
