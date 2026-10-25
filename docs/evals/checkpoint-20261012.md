# Isolated branch commit checkpoint — 2026-10-12

Kiran requested a clean stopping point and four local topic commits: vehicles and
finish fixes, neon preset, art pass, and audio. This checkpoint supersedes the
historical no-commit instructions in the earlier evaluation records. It does not
authorize a push, merge, new cloud job, or further feature development.

## Acceptance and ownership

- Commit the completed source, tests, required baked assets and evaluation records
  on `codex/isolated-finish`; split shared integration files by topic.
- Preserve the final working-file bytes while staging the intermediate snapshots.
- Keep main at `cb35f065f7b5b78a2e38a61bc61a321fc5c6244e` and preserve the seven
  protected main/Claude file hashes from `tools/_codex-preserved-files.json`.
- Verify types, changed-source lint, focused tests, production build and whitespace.
  Record scope limits instead of equating compilation with visual acceptance.
- End with four new local commits and a clean tracked/untracked working tree.
  Ignored dependencies, build caches and diagnostic staging remain local.

The authenticated GitHub login and repository owner are both `KiranMohan-92`.
Repository metadata confirms `private: true`, `fork: false` and administrator
access. No remote publication is part of this checkpoint.

## Topic boundaries

1. **Vehicles and finish fixes:** rendered-surface physics queries, grounded actor
   presentation, debris/contact effects, warm-up, shadow-preserving AO, GPU timing,
   Market stair landing and its regenerated base lightmaps. Earlier vehicle and
   wreck improvements already exist in the branch history.
2. **Neon preset:** sightline fog adjustment, signage, baked ground/static light,
   weather/material integration, local and optional cloud bake tooling.
3. **Art pass:** columns and Palace stone, portico relief, facade continuity,
   district and stall details, projected-size prop LOD, tree filtering and assets.
4. **Audio:** surface footsteps, queued spatial blast/remote gunfire presentation,
   acoustic tests and the controlled offline review tooling; this checkpoint.

These are ordered checkpoints of one integrated branch. Bake exporters fingerprint
the final art sources; use the final four-commit state when regenerating assets.

## Validation and correction record

The first Palace slice passed 74 tests, including the original 65,000-triangle
Low facade budget, plus types and scoped lint. The final changed TypeScript and
JavaScript lint pass succeeds. The production client build passes with 266 modules;
`index-RtlKQlFU.js` is 8,102.14 kB, gzip 3,048.41 kB. The existing chunk-size warning
remains. Typechecking passes after moving the temporary diagnostic out of the
tooling project's TypeScript input set.

Python asset/bake validation passed **59 tests**. Node-runner checks passed **nine
tests**: six neon exporter checks and three tree bake reduction checks. Final
Vitest run passed **358 tests in 44 files** in 160.86 seconds; the companion JSON
receipt records the checked source and asset hashes. These checks cover the
changed tests, not the entire repository test suite or browser multiplayer E2E.

The broader initial run encountered Windows temporary-directory access failures
and incorrectly routed Node-runner test files through Vitest. Rerunning with a
fresh workspace-local temporary directory and the project's TSX Node runner
resolved those environment/runner failures. Source assertions and budgets stayed
unchanged.

The remaining genuine failures identified stale Palace/neon bake fingerprints:
the stair landing correction changed the resolved map geometry and atlas layout.
Three fresh Blender 4.5.14 **CPU** bakes were exported and validated locally:

| Bake                     | Resolution  | Samples | Measured bake seconds |
| ------------------------ | ----------- | ------- | --------------------- |
| Palace courtyard         | 256 × 256   | 32      | 1.232                 |
| Market neon ground       | 512 × 512   | 128     | 11.792                |
| Market neon static atlas | 2048 × 1560 | 128     | 12.018                |

All three now bind to scene hash `0608001d02fe75`; the neon atlas layout is
`1f8605625ccbab`. The strict installers validated the regenerated files. All
**35 bake/map tests** then passed, including stale-scene rejection, texture upload
and Low fallback. No compatibility gate was bypassed and no Modal job was run.

Ignored detailed receipts remain under `tools/assets/build/checkpoint-*20261012*`.
The published pilot manifests retain bake provenance and texture hashes.

## Remaining acceptance limits and lessons

Improvements through 37 have their earlier visual records. The current masonry
coverage shader has a 120-case NVIDIA GLSL receipt with zero failures and maximum
absolute error `1.966953168341945e-6`. This verifies coverage math, not full-scene
visual quality. The portico frieze and latest material work pass their focused
contracts; a final matched full-scene review of the entire latest batch remains
open. Whole-Market AAA fidelity, sustained moving/combat frame pacing, broad
collision/explosion playtesting and final sound-mix listening remain unaccepted.

One writer handled this checkpoint; no live helpers were running. Corrections were
temporary-directory/runner setup, diagnostic input cleanup and genuine stale-bake
regeneration. No comparable sequential baseline, speedup or measured cloud cost
is available. The reusable lesson is to regenerate dependent lighting after map
geometry changes and distinguish runner failures from actual contract failures.
