# Palace bake pilot

Acceptance set before implementation, 2026-10-04. Work belongs to `codex/isolated-finish` in the separate checkout. Original main and Claude's files must remain unchanged.

- Produce an actual small Cycles bake locally, then use the same scene and baker for an optional single Modal GPU job. No cloud spending during preparation.
- Entrance columns retain their existing silhouette, merged draw and collision boxes. Bake fine stone surface detail; keep moving sunlight and wetness in the browser.
- Bake colored entrance illumination from the existing cyan sign onto a bounded ground region. Export map geometry and exact sign placement, rather than inventing a disconnected demonstration scene. Reject stale scene data. Night lighting switches off in other weather.
- Keep the current paving geometry and gameplay unchanged. The ground bake adds a texture lookup to existing materials, with no lights, shadow maps or extra geometry draws. Low receives the same small pilot texture.
- Verify baking output, UV/world alignment, weather gating, shader composition and existing rendering regressions. Build the client and inspect the actual browser. Record measured time, bytes and any unresolved performance or fidelity limits.

Modal preparation must constrain the upload, image size, samples, one container, no retries and execution timeout. Those bounds limit a job; they are not a dollar spending cap. Launching the paid job still needs Kiran's spending limit. No merge to main, deployment or push is included.

## Execution record

Baseline: isolated HEAD `d243fe3`, clean tree. Prior capture on Intel UHD at 1280×720: Low adaptive 60%, 56 fps; High fixed 100%, 25 fps. These were short stationary samples, not comparable bake benchmarks or combat measurements. See `ARCHITECTURE-PASS.md` for exact qualifications.

Two bounded helpers prepared stone authoring and the ground baker/exporter; root integrated and verified the final snapshot. Modal spend was zero. No sequential baseline exists for an agent speedup comparison. A generated texture and a stronger local scene do not establish AAA quality.

Final local result: the resolved `defilad/market` entrance scene contains 133 meshes and 3,612 triangles, layout hash `1b782bd5e0309c` and scene hash `04a6e4a153e4e4`. Blender 4.5.14 CPU baked the 256-square courtyard at 128 samples in 3.752 s: 53,229 bytes, max radiance 7.763, mean 0.698, 187,495 nonzero RGB channels and zero clipped channels at scale 16. The installed image's dimensions, alpha and SHA256 were checked independently.

The three procedural sandstone maps are 323,012 bytes together. Regenerating from the final source took 4.285 s and reproduced all three installed files exactly. These maps are authored heightfield materials, not a high-poly Cycles surface bake. Four textures total 376,241 bytes (about 367 KiB), approximately 1.33 MiB GPU storage with RGBA mipmaps. The existing merged column draw and collision footprint remain unchanged.

Review corrected receiver/sign winding, pixel-row orientation, factory World ambient leakage, duplicated old column occluders, concave cap triangulation and an exporter working-directory mistake. It also caught settings replacing the new column maps. Two helpers crossed their stated integration ownership, causing duplicate imports/preloads; root removed them and centralized final edits. Future slices should enforce file ownership more tightly. One existing test needed its expected shader cache key updated; the first integrated render run was 69/70, the corrected run 70/70. These were code/integration failures, not cloud failures.

Final verification: typecheck, scoped ESLint, seven rendering files (70 tests), 11 offline bake/cloud-contract tests, two stone-data checks, Python compilation, client production build and diff whitespace checks passed. The build retains the existing large-bundle warning. A fresh browser loaded the pilot with no captured warnings/errors. Actual preview: `tools/_codex-palace-preview.png`; stationary overlay: `tools/_codex-palace-perf.png`, Intel UHD, 586 x 668 window, Low at 100%, 57 fps, average 17.60 ms, p99 18.30 ms. This is a short stationary observation, not an equivalent baseline or combat benchmark. Automated browser mouse capture was denied; the existing automated startup page was used to inspect rendering, then the normal playable menu was restored.

Original main remains `cb35f065f7b5b78a2e38a61bc61a321fc5c6244e`, with only its two pre-existing untracked paths. All seven preserved original/Claude files match baseline hashes. Work remains uncommitted on `codex/isolated-finish`; no push, merge or deployment occurred. The full repository `pnpm check` was not rerun for this slice, so no commit was made under its commit gate.

Remaining limits: this is a small Palace-entrance pilot. The ground export omits detailed external prop/model occluders; it validates map/sign compatibility, while future procedural mesh-code changes require explicit re-export/rebake. Only the static sign's ground illumination is baked; moving shadows and reflections remain real time. Larger assets, close-up art review, combat performance and an actual Modal CUDA job remain unverified. A paid GPU was unnecessary for this small local bake.
