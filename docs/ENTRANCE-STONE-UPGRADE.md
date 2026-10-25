# Palace entrance stone continuation

Scope: local `codex/isolated-finish` only. Preserve main, Claude work, collision, map layout and existing baked lighting. No commit, push or Modal job.

Acceptance before editing:

- The lower east Palace entrance shell shares the columns' sharper sandstone, with metre-scaled masonry joints, restrained variation and existing sill weathering. Windows and glass remain unchanged. Transitions into the rest of the facade are soft.
- Reuse the already-loaded column textures: no new image download, GPU texture allocation, mesh draw, lights or shadow passes. Additional fragment work must remain confined to the entrance and preserve the existing facade distance LOD.
- Keep baked AO on its original UV channel and combine its indirect-light occlusion with the new material. Preserve wetness, grid mode, quality switching and the asset-failure fallback.
- TypeScript, scoped lint/format, focused material/facade/column/weather tests and client build pass. Inspect matching actual browser views in daylight and neon; report limitations without claiming AAA quality or measured frame-rate gains.
- Main revision/status and seven original/Claude file hashes match the preservation record.

Decision: reuse the column source for a bounded material pass on the existing entrance shell. Higher resolution alone is insufficient; matching material response and the existing architectural relief should make the entrance more coherent.

## Verified result — 2026-10-04

The lower east entrance walls and soffit now sample the same 1K sandstone set as the columns. The existing shell geometry, sill weathering, window panes, facade distance LOD, sky-occlusion atlas and collision remain in place. The spatial mask covers x 37–54, y 0–22 and z -22–20, with a smooth two-metre fade outside those bounds. Metre-scaled, filtered joints and gentle pore occlusion add surface detail; this is shading detail, not newly sculpted masonry. Existing weather lighting is unchanged.

The pass reuses the three texture objects already loaded for the columns. No images, geometry, draws, lights or shadow passes were added. It performs three additional texture samples on entrance-shell fragments; unrelated shell fragments retain their original shading, with the mask check as additional shader work. The original baked AO texture and UV channel 1 are preserved. Entrance roughness is applied before wetness, so exposed surfaces still get the rain film. A per-material shared grid uniform avoids retaining historical shader objects and restores the level-design grid correctly.

Verification on the final source snapshot:

- Nine focused rendering test files: 89 passed, 40.25 seconds. Covers the material fallback, shared texture identity, spatial fade, grid transitions, baked AO, window exclusion, facade LOD, column geometry and weather contracts.
- Native TypeScript, scoped ESLint, Prettier and whitespace checks passed.
- Production client build passed in 2.90 seconds; the existing large-bundle warning remains.
- Actual daylight and neon browser comparisons rendered without shader/asset errors. Normal preview also switched Low → High → Auto without reported errors, restoring its original Auto setting and keeping dynamic resolution enabled.
- Main stayed at `cb35f065f7b5b78a2e38a61bc61a321fc5c6244e`, with only its pre-existing untracked files; all seven original/Claude file hashes matched. No commit, push, merge or Modal job.

Actual captures and final source hashes: `C:/Users/kiran/myprojects/gameplay-captures/2026-10-04/entrance-stone/`. Before is the branch after the column upgrade; after is this entrance pass. `entrance-daylight-before-after.png` and `entrance-neon-before-after.png` have before on the left and after on the right. Individual matched views and `verified-snapshot.json` remain beside them. Temporary review servers were closed; http://127.0.0.1:5174/ remains connected and playable.

## Execution ledger and lessons

One helper owned the new material and its tests; the main agent owned integration, ceiling extension, browser review and final checks. A read-only lookup helper could not start because its configured model was unavailable; the main agent performed that lookup. No sequential timing baseline or cost measurement was available, so no speedup or cost estimate is inferred. Modal spending was zero.

Review corrections before acceptance: mirror smoothstep exactly in the pure mask test, cache ORM once rather than sample it twice, guard normal-map uniforms for no-normal fallback, and keep shader state out of serialised material user data. Final integration replaced historical shader tracking with one shared grid uniform per material. The first lint pass found an unnecessary async test loader; the ceiling extension first exposed a TypeScript union-type error, resolved by configuring the known shell material directly. The initial final suite passed 71 tests; the final expanded suite passed 89. The final browser controls needed DOM roles instead of label selectors; no product defect resulted.

This is a coherent entrance material improvement, not a whole-scene AAA result. A controlled GPU benchmark was not run; added fragment work means a frame-rate gain is not claimed. Priorities beyond this slice remain better surrounding assets and broader lighting/art direction. Matching palette, physical scale and shader ordering matters more than simply increasing texture resolution.
