# Palace column art upgrade

Scope: the eight east-portico columns in `codex/isolated-finish`. Preserve the original main checkout and Claude work. Keep game collision, map source, route and combat unchanged. Work remains local and reviewable; no commit, push, merge or cloud job is included.

Acceptance before editing:

- Curved flutes, rounded moulding and chamfered stone edges read from the approach and a close-up, rather than square extruded strips.
- A sharper, restrained sandstone material has matched normal/roughness relief and colour variation. Colour texture does not contain a painted column, shadows or highlights. The asset may be AI-authored; that is not photogrammetry or an AAA-quality certification.
- Geometry remains inside the existing eight 1.3 × 12 × 1.3 metre boxes. One merged draw, at most 25,000 triangles across the set, no added lights or shadow passes.
- All shading attributes, UVs and triangle winding are valid. Low quality retains the column normals; settings changes restore the maps; preloading completes before play, with a fallback if assets fail.
- Native TypeScript, scoped lint/format, meaningful rendering/geometry tests and client production build pass.
- Inspect actual in-browser approach and close-up under neutral daylight and the existing neon preset. Save comparison proof. Report measured texture bytes, estimated GPU storage and geometry counts; do not claim a performance gain or an AAA result without evidence.
- Verify main revision/status and the seven original/Claude file hashes still match.

Decision: locally author and integrate the small material/mesh slice first. A cloud GPU would reduce offline render time on larger scenes but would not improve an unchanged model, add missing UVs or relieve the browser's runtime rendering load. No paid Modal job is necessary for this slice.

## Verified result — 2026-10-04

The eight columns now have concave curved flutes, rounded corners, bevelled moulding and shallow stone-course seams. Slope-aware bevel normals and an analytic crevice attribute improve indirect shading without darkening the direct sunlight calculation. The set is still one merged mesh: 22,400 triangles (2,800 per column), inside the original collision bounds. No lights or shadow passes were added. The greater triangle count does add work to the existing shadow pass.

A generated 1,254 × 1,254 sandstone colour source was downsampled to native-detail 1,024 × 1,024 maps, replacing the previous 256-pixel maps. There is no upscaling. Fine luminance relief supplies inferred pore normals and roughness, rather than a measured or sculpt-baked surface. The packed material map uses R for gentle pore occlusion, G for roughness and B=0 for non-metal stone. The new albedo, normal and packed map total 4,688,522 bytes (approximately 4.47 MiB); estimated RGBA8 GPU storage including mipmaps is approximately 16 MiB. Source and output hashes, colour spaces and provenance are in `packages/client/public/tex/palace-columns-v2/manifest.json`.

Validation passed:

- Six focused rendering/geometry test files: 62 tests. After an assertion-only lint cleanup, the two column files passed again: 16 tests.
- Three Python material contract tests, including rejection of fake resolution increases.
- Native TypeScript compilation, scoped ESLint and Prettier, whitespace checks and the final production client build. The existing large-bundle warning remains.
- Actual browser review in daylight and neon at High quality, 100% render scale. No shader or asset errors were reported in the fresh review loads.
- Main remained at `cb35f065f7b5b78a2e38a61bc61a321fc5c6244e`, with its pre-existing untracked files. Seven original/Claude file hashes matched. No commit, push, merge or Modal job was performed.

Final source hashes are retained in ignored `tools/_columnReview/verified-snapshot.json` and copied beside the captures. The normal playable branch remains at http://127.0.0.1:5174/.

## Visual evidence

Actual screenshots and the execution snapshot are in `C:/Users/kiran/myprojects/gameplay-captures/2026-10-04/columns-v2/`:

- `columns-before-after.png`: daylight close-up, previous branch column pass on the left and this upgrade on the right.
- `columns-full-before-after.png`: matching daylight full-column views.
- `columns-neon-before-after.png`: matching neon close-up views.
- Individual full, close-up and capital captures are retained as well.

These compare the previous isolated-branch columns with the new columns, not main. The earlier main-versus-branch video remains in the separate `main-comparison` directory and predates this pass. The review servers injected visible camera controls and identical scene settings; animated rain and weapon idle frames can differ. The before material retained the review's anisotropic filtering setting, so this is an art comparison, not a pixel-identical replay of a previous binary.

One stationary render-stat observation reported 398 scene draws and 49.8 FPS. It is not a benchmark or evidence of a frame-rate gain. Whole-scene AAA quality is not established by this column pass; lighting, surrounding assets and runtime frame budgets remain broader work.

## Execution ledger and lessons

Ownership: one bounded geometry helper; the main agent owned material generation, shading, integration, tests and review. The final column test suite had no failures. Initial integration needed corrections: bevel normals required a vertical slope component, flutes required more samples, and the earlier flat-geometry assertions needed to reflect curved carving. Review prompted the indirect crevice shading addition. A transient test import failure occurred during a helper's file replacement; copied TypeScript review backups also entered tool compilation until renamed as text. Neither was a shipped runtime defect.

Environment corrections: the bundled Python lacked pytest and the default test temporary directory was restricted. The installed native Python and a bounded project-local test directory passed. Material preparation took 1.934 seconds; the final production build reported 3.60 seconds. Image-generation cost, total elapsed time and a comparable sequential baseline were not measured. Modal spending for this task was zero; no speedup is inferred.

Retain native-resolution sources, use inferred material maps honestly, keep comparison backups outside compiler inputs, and review sculpted normals under more than one lighting preset. Higher image resolution alone does not replace geometry, material response or lighting.

## Download budget follow-up — 2026-10-12

The current column outputs are 1024 × 1024 WebPs totaling 252,930 bytes, replacing
the PNG downloads described above. GPU RGBA8 storage remains about 16 MiB with
mipmaps. The shared encoder matches colour to JPEG q85 and encodes data at q92.
A 0.5-pixel colour Gaussian filter and median/Gaussian prefiltering of inferred
normal/roughness data reduce fine noise before compression. The manifest records
the filters, dimensions, bytes and SHA256 values. Decoded-output tests bound normal
angular error and roughness error and check albedo PSNR; this is offline fidelity
evidence. The original browser captures above predate this filtering.
