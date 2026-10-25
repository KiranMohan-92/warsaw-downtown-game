# NOCNY RYNEK ground illumination staging

This pipeline stages a bounded RGB Cycles diffuse bake for the actual Market landmark tile
`[76, 30, 112, 62]`, at world ground height `0.02`. Export and bake commands stage files;
the separate strict installer publishes validated assets only to the linked isolated checkout.
Importing these tools does not start hosting or launch a Modal job. Work belongs to
`codex/isolated-finish`; preserve main and all other concurrent edits.

## Local export and evidence

Run from the isolated checkout using the existing native Node/TSX installation. Using these
direct paths avoids the local pnpm wrapper's attempted dependency reconciliation:

```powershell
& 'C:/Program Files/nodejs/node.exe' packages/server/node_modules/tsx/dist/cli.mjs tools/bake/export-market-neon.mjs --out tools/assets/build/market-neon-staging/scene.json
& 'C:/Python314/python.exe' -B -m unittest discover -s tools/bake -p 'test_*market_neon*.py' -v
& 'C:/Program Files/nodejs/node.exe' node_modules/vitest/vitest.mjs run tools/bake/export-market-neon.test.mjs tools/bake/export-market-neon-static.test.mjs
```

The exporter uses the current resolved `defilad/market` map and actual procedural stall
canvas/posts/trays. Tagged scanned props use the shared world-space triangle surfaces, so
crate slats and barrier profiles replace their bounding boxes. Invisible colliders are omitted.
Map boxes, triangulated prisms and decor are selected within the tile plus 16 metres of padding.
Every existing sign whose centre lies within 16 metres plus half its width is selected with its
actual position, dimensions, colour and yaw. Currently only `NOCNY RYNEK` qualifies. The other
three signs' remote contribution is deliberately omitted, rather than claiming full-Market GI.

Mesh names/counts, quantized world vertices, triangle indices and flat diffuse colours have
a SHA256 fingerprint computed independently in JavaScript and Python. Sign properties have
another fingerprint. The input also records current-map/layout hashes and SHA256 values of
the exporter, baker, shared utility, dressing/sign sources, current map authoring/resolution
sources and shared prop geometry. Original
upload bytes are SHA256-hashed and checked against the cloud response. Re-export after any
geometry, emitter, shader authoring source, or baker change; keep the staged snapshot for review.

Local Blender example, using the existing binary read-only:

```powershell
& 'C:/Users/kiran/myprojects/warsaw-downtown/tools/blender/blender-4.5.14-windows-x64/blender.exe' -b --factory-startup --python-exit-code 1 --python tools/bake/market_neon_bake.py -- --scene tools/assets/build/market-neon-staging/scene.json --out tools/assets/build/market-neon-local-review --size 128 --samples 16 --device cpu
```

Output must be a new or empty staging folder. Local validation supports `128/256/512/1024`
square pixels and up to 128 samples. The scene is capped at 8 MiB, 4,000 meshes, 500,000 vertices
and 300,000 triangles. Offline result quality does not establish AAA fidelity or gameplay
frame rate; installed assets still require actual in-game validation.

## Validated local reference and isolated installation

The staged scene `tools/assets/build/market-neon-staging/scene-current.json` contains 306
meshes and 114,336 triangles. The local reference in
`tools/assets/build/market-neon-cpu-current-map-reference/` uses Blender 4.5.14, **CPU**, 512
square pixels and 128 samples, measured at 25.589 seconds. It is a local reference, not
evidence of a Modal GPU run. The 21 Python and three exporter tests pass; remote-image
execution remains unverified.
The PNG contains 28,269 bytes; maximum pre-encoding radiance is about 3.608, mean 0.0850,
and clipped channels are zero. The unchanged lighting/geometry repeat produced the same
PNG SHA256 `6269a5cf0fac2b3838ef33ebb3ffcb5f22d6124a3dc21e0733cf757f4dff95fa`.

```powershell
& 'C:/Python314/python.exe' -B tools/bake/install_market_neon.py tools/assets/build/market-neon-cpu-current-map-reference --scene tools/assets/build/market-neon-staging/scene-current.json
& 'C:/Program Files/nodejs/node.exe' node_modules/prettier/bin/prettier.cjs --write packages/client/src/render/marketNeonBakeManifest.ts
```

The installer requires a linked worktree on `codex/isolated-finish`, exact current source
fingerprints, matching scene/layout/emitter/geometry/input hashes, the linear orientation
contract, 512/1024 dimensions, 128 samples, finite nonzero metrics and zero clipping. It
validates PNG CRCs, bounded decompression, dimensions, opaque alpha and nonzero RGB. It
only writes `packages/client/public/lightmaps/market-neon-pilot/market-neon-ground.png`,
that folder's `manifest.json`, and `packages/client/src/render/marketNeonBakeManifest.ts`.
The manifest records CPU/CUDA provenance, measured bake duration and original input SHA256.
The seven installer tests reject main/non-linked installs and stale or malformed results.

## Optional single Modal job

No cloud job was launched during preparation. The existing optional Modal environment is
`tools/_modal-account` (local Python 3.14, Modal SDK 1.6.1). Authentication and an explicit positive
user-approved spending amount are required for the cloud call, not for export/local tests.

```powershell
& ./tools/_modal-account/Scripts/modal.exe run tools/bake/modal_market_neon.py --scene tools/assets/build/market-neon-staging/scene.json --output tools/assets/build/market-neon-cloud-review --size 512 --samples 128 --approved-budget-usd <authorized-limit>
```

The worker uses one L4, four CPU cores, 8 GiB RAM, a 600-second execution timeout, no retries,
one maximum container and a two-second scaledown window. Its Debian/Python 3.11 image pins
`bpy==4.5.0`, installs `xorg`/`libxkbcommon0`, and copies only the baker and existing encoding
utility. The scene upload is at most 8 MiB, returned files at most 16 MiB. Remote sizes are
512 or 1024, up to 128 samples. CUDA absence fails; no silent CPU fallback is allowed.

`--approved-budget-usd` is an authorization record, **not a billing cap**. Resource/execution
bounds do not cover image-build/platform costs or enforce dollar spending. Check current
pricing and account spending controls before a run. Do not restart a remote job after an
observation timeout without first checking its actual job state.

The response goes only to a new local folder with `market-neon-ground.png`, `manifest.json`
and `receipt.json`. Output SHA256, input SHA256, geometry fingerprint, manifest identity,
CUDA provenance, PNG dimensions and RGBA8 encoding are checked before writing the receipt.
The fake API tests validate these contracts; they do not prove the remote image builds or runs.

## Lighting contract and limitations

The white Lambert receiver stores **diffuse outgoing radiance `E/PI`**, not colour/albedo or a
display-rendered screenshot. RGB is linear RGBA8, fixed radiance scale 16, alpha 255; PNG row
zero represents minimum world Z. Runtime upload uses `flipY=false`, no colour-space transform,
clamped edges, mipmaps and boundary feathering. Convert back to irradiance with `16*PI`, then
apply the receiving material's Lambert BRDF. Do not run sky AO on this already occluded term.
It is designed to match the existing courtyard projection contract. Runtime integration is
owned separately; the generated manifest is its explicit asset contract.

General sign yaw matches the browser's panel normal `(sin(yaw),0,cos(yaw))`. An opaque housing
with the browser's dimensions/offset blocks rear emission. The panel's uniform radiance 120 is
an artistic calibration, not measured signage; lettering/alpha is not reconstructed. Only the
selected neon panels emit. Sun, sky, room lamps, stall strips, actors, changing wetness and
camera-dependent reflections are excluded. Existing painted additive neon ground glows must
be reviewed/gated during integration to avoid double illumination.

Hero/wreck models, tree crowns, soft foliage cards, centimetre-sized produce and district trims
are not represented. Authored solid hedge boxes are included as ordinary opaque geometry.
Occluder colours are approximate flat diffuse values: textured albedo, metallic reflection and
translucent cloth are not imported. The flat receiver does not cover raised floors, walls,
actors or underground spaces. A high-resolution landmark bake is a useful step; it is not a
whole-Market AAA result.

During runtime review, inspect actual daylight/night landmark views, weather/quality/map switches,
loading failure fallback and disposal. Measure movement/combat frame-time distributions and
texture memory on the verified NVIDIA device. Preserve the staged source fingerprints and main
hashes as evidence. Zero clipping and nonzero light are necessary checks, not visual approval.
