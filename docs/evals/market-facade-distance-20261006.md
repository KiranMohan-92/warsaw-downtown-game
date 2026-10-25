# Facade distance pass — acceptance and evidence

Scope: isolated `codex/isolated-finish`; no commits, pushes, main edits, or remote jobs.

Before editing: the existing facade weathering shader fades all weathering between 45 and
70 metres. This also removes metre-scale colour variation that is still resolved from the
Market hall's upper windows. Texture dimensions alone cannot correct this cutoff.

Acceptance checks:

- Preserve broad facade variation across the hall-to-Palace sightline; filter fine streaks
  according to their projected texel footprint instead of sharpening subpixel noise.
- Keep window layout, geometry, collision, head placement and game settings unchanged.
- Add no downloads, draw calls or geometry. Preserve linear albedo and indirect-only cavity AO.
- Reuse the already-loaded authored column PBR set across Palace-classified facade walls
  at all LODs. Exclude surrounding blocks and painted window pixels; keep the procedural
  fallback when the stone set is unavailable. Add only one normalized byte per facade vertex.
- Capture the actual game from fixed hall and forecourt poses, High at 100%, DRS disabled,
  at the same viewport before and after. Check day and night for shader errors.
- Run relevant facade shader, geometry and material tests, typecheck, lint and build.
- Verify the preserved main HEAD and seven Claude-file hashes.

Moving-soldier checks are assigned separately to a bounded helper which owns only new test
and report files. Any moving-contact failures must be reported and resolved separately from
facade art; the stationary stair results do not establish moving-contact correctness.

## Verified result

Palace facade walls now reuse the already-loaded authored stone albedo, normal and ORM
set. A normalized byte per vertex selects Palace surfaces; painted window pixels and
surrounding blocks retain their materials. The fallback remains available. Geometry,
collision and draw counts are unchanged. The weathering shader filters fine detail using
screen-space derivatives and retains resolved broad stains instead of fading everything
between 45 and 70 metres. Shader cache keys distinguish the new variants.

Five focused files passed all 62 tests in 47.01 seconds. Types, scoped lint and production
build passed. The build processed 261 modules in 4.59 seconds; index-BxrAH5sa.js is
8,092.93 kB (gzip 3,045.08 kB), with the existing large-chunk warning. The first test run
needed one obsolete paint-material expectation updated; an unused probe import was fixed.

An independent visual review found less chaotic stone repetition and better window
contrast, but still shallow facade relief, repeated windows and soft broad grime. Its
cooler preview also lost warmth; a modest facade-only tint was applied after that review.
This is a material improvement, not accepted whole-map AAA quality.

The new moving-contact probe passed one test in 22.03 seconds. It measured skinned boot
vertices over 128 frames / 256 boots with both rigs and recorded 126 contacts classified
as planted, with maximum positive gap about 1.2 cm. Classification is based on the
existing planted/swing rule. Swing-foot toe penetration reached 3.43 cm in the flat
probe; continuous character-controller stair traversal and all combat poses remain
unverified. Root, head and gun position deltas were zero. Raw details are retained in
tools/assets/build/soldier-moving-contact-20261006.json.

## Runtime evidence and limits

The accepted fixed 1280×720, High, 100%, DRS-off hall sample lasted 15.0181 seconds and
recorded 523 parent-frame intervals: median 16.7 ms, p95 65.9 ms, p99 66.7 ms, with zero
hidden frames. The proposed 25 ms p95 target was not met. This is a static actual-game
view, not a moving/combat benchmark or a controlled before/after performance comparison.
OS focus and other workloads were not proven controlled; parent-frame scheduling is
not identical to a game-frame GPU timing measurement.

The in-app browser reported ANGLE on NVIDIA Quadro T2000 with Max-Q Design, D3D11.
The scene reported 587 draws and 2,042,152 triangles; the ending GPU median was 10.19 ms.
This confirms this browser's NVIDIA renderer, not all Chrome profiles. Two earlier
samples are excluded: one overlapped tests, and another used a changed viewport.

Screenshots and the three raw frame receipts are under
C:/Users/kiran/myprojects/gameplay-captures/2026-10-06/market-quality/.
The dev-only facade-review.html uses the actual game at fixed hall/forecourt poses;
it does not save settings. Its night check initially used an unsupported weather ID,
then exposed a missing explicit settings-application call. Both fixture issues were
corrected before final capture. Production weather handling was unchanged.
The original diagnostic tab remained unresponsive during reload and flooded the Vite
console with its old invalid value. Only the isolated 5174 server was restarted. A fresh
review tab rendered the supported neon preset with no reported errors, and its screenshot
was saved. The browser viewport override was reset and the fresh tab returned to the
playable branch. The browser API could not bind the stalled original diagnostic tab;
its cleanup was not verified. The preview server returned HTTP 200 after recovery.

The main HEAD remains cb35f065f7b5b78a2e38a61bc61a321fc5c6244e and all seven preserved
Claude-file hashes matched. No commit, push or Modal job was performed. Modal execution
still needs an approved positive spending cap and an actual CUDA receipt. Asset-depth,
swing-foot clipping, moving combat frame pacing, listening checks and whole-map AAA
acceptance remain open. Exact source hashes and the compact retrospective are recorded
in the adjacent JSON ledger.
