# Market produce and stall lighting

Continuation on `codex/isolated-finish`. Original main/Claude work preserved. No cloud, publication or paid job.

## Acceptance before editing

- Preserve map/physics/cover and previous timber finish. Capture the current branch before this pass.
- Smooth only nearby produce, with at most 512 detailed instances and one added draw. Retain original distant fruit and existing ten-metre culling. Bound the additional smooth geometry to 86,016 submitted triangles, not an unbounded upgrade of every fruit in the map.
- Precompute light from an actual visible warm strip under each existing awning, matching fixture position/dimensions. Sample its rectangle once at map construction and reject paths blocked by the stall counter/back panel. Do not call this full global illumination.
- Reuse original images. No dynamic lights, shadow pass, per-frame ray tracing or paid GPU job. Account for extra attributes, materials and vertex work honestly.
- Test nearest-detail cap, movement/teleport restoration, idempotent updates, no duplicate visible fruit, exact transforms/colours, finite geometry, directional lighting, occlusion, and shader composition. Check types, focused lint, build and real daylight/neon frames.
- Record actual results and remaining gaps. Stationary FPS observations do not establish an improvement or a combat benchmark.

## Verified result — 2026-10-04

- `marketProduce.ts`: a single camera-near sphere batch (12 × 8 segments), maximum 512 instances within 2.75 m; selection updates after 15 cm movement. Original coarse matrices are restored exactly on movement/teleport. Fine instances inherit original transform, colour and light. Coarse replacements retain tiny finite scale, avoiding singular normal transforms.
- `marketStallLighting.ts`: eight load-time rectangle samples, counter/back-panel segment occlusion, warm irradiance and weighted world direction. Rotation preserves irradiance magnitude. Reused sampling temporaries avoid per-vertex sample-vector allocation. This is direct fixture lighting, not a full GI bake.
- `setDressing.ts`: visible diffuser/housing merged with existing chunks; per-vertex and per-instance fixture coefficients. Timber uses a cached material variant sharing existing images, wetness and grid settings; the general map wood shader remains unchanged. Produce shares a slightly smoother, unmapped material between coarse and near batches.
- Final focused verification: 5 files / 37 tests passed (6.21 s reported test-run wall time), TypeScript build and scoped ESLint passed. Production build passed in 2.14 s with the existing large-bundle warning. No browser console errors in sunny/neon review scenes.
- Matched counter view: 815,130 → 856,194 assembled dressing triangles, 33 → 35 dressing batches. These inventory counts include distant/cullable meshes. The detailed-produce ceiling is 86,016 additional submitted triangles. Recorded stationary FPS (30.9 before / 29.1 after) is not a controlled performance comparison; no speedup or ultra-framerate claim.
- Eight actual game screenshots use matching camera poses, High / 100%, sunny and neon. Baseline is the isolated branch immediately before this pass, already containing timber improvements; it is not original main. Evidence: `C:/Users/kiran/myprojects/gameplay-captures/2026-10-04/market-produce-lighting/`.
- Original main remains `cb35f065f7b5b78a2e38a61bc61a321fc5c6244e`, with the same pre-existing untracked handoff files. Seven preservation hashes checked, zero changed. No commit, push, Modal job or paid render.

## Execution ledger and remaining work

Root owned produce and integration; a bounded helper owned fixture calculations/tests. The helper crossed into the integration file, causing one rejected patch; root retained those changes, reclaimed integration ownership and revalidated the combined result. Future helpers should remain inside their assigned files. First combined focused verification passed; there was one integration patch rework and one invalid documentation patch, no test/environment failure. Measured costs and comparable sequential timing are unknown.

This is a completed produce/fixture slice, not a completed AAA district. Containers, stall-specific props, finer organic fruit surfaces and stems, varied wear, and wider Market lighting still need work. Full movement/combat frame-time benchmarking remains unverified. Temporary review servers are retired after capture; normal branch service remains on port 5174.
