# Market frame causality — 2026-10-08

Previous goal turn: progress. Six tree atlases, packed AO sampling/mips, tests,
day/night captures and provenance receipts changed authoritative state. Whole-map
AAA quality and smooth combat remain unproven; the active goal retains that scope.

Acceptance before diagnostics/edits:

- Work only in codex/isolated-finish; preserve main and Claude hashes.
- Measure the shipped real Market game on NVIDIA at High, 100%, DRS off with a
  fixed hall pose. Separate callback intervals from CPU frame, simulation, render,
  facade update and post-render submission durations. Nested durations are not added.
- Collect browser long-animation-frame/long-task attribution when supported, record
  unsupported APIs, visibility, GPU, exact viewport, start/end state and sampling cost.
- Warm up before collecting 20 seconds; update diagnostic DOM only once a second.
  No tests, build or asset encoder during collection. Retain failed targets.
- Any optimization must address an observed cause and preserve rendered quality,
  physics and simulation semantics. Verify with relevant regressions and real scene
  samples. Do not erase detail to satisfy an easier frame target.
- Inspect current facade mechanisms before proposing more layers. Existing lighting,
  authored stone and window shaders are not new improvements.
- No cloud job until the existing request for a positive Modal spending cap is answered.

Candidate acceptance (scene matrices): update the world once before all frame passes;
leave the viewmodel and camera update paths intact. Honor an explicitly disabled
scene auto-update flag. Restore the flag on both success and failure. Regression
checks must exercise nested, animated transforms across successive frames, High's
depth/world/AO transparency passes and Low's path. Retain the same geometry, passes,
resolution and shadow refresh behavior. Compare fixed-pose render receipts, while
reporting frame pacing separately; faster matrix work alone does not prove smoothness.

## Observations and retained candidate

The initial broad profile (513 frames) has simulation p95 0.6 ms, rendering p95
33.1 ms and callback intervals p95 107.6 ms. The granular repeat (680 frames)
has world matrix work median 1.4 ms / p95 3.2 ms, world pass median 5.1 ms,
AO transparency median 1.8 ms; simulation remains small. Nested timings overlap.

`PostPipeline.render` now updates the world once before its depth/world/AO passes
and temporarily suppresses the renderer's repeated scene updates. It restores
automatic updates in `finally`, honors manually managed scenes, and leaves camera,
viewmodel, shadows, geometry, effects and resolution intact. Render callbacks were
inspected: foliage changes camera-dependent wind uniforms; rain changes viewport
uniforms. Neither changes world transforms between passes.

Three consecutive 20-second quiet samples use a dev-only selector for the exact
previous High path and the candidate. Each warms for three seconds, measures actual
game frames, and retains all rows. No build/tests/encoders run during sampling.

| Sample      | World updates/frame | Matrix median / p95 ms | CPU frame median / p95 ms | Interval p95 ms |
| ----------- | ------------------- | ---------------------- | ------------------------- | --------------- |
| Baseline A  | 4 / 4 min/max       | 1.3 / 2.3              | 10.6 / 17.9               | 122.7           |
| Candidate B | 1 / 1 min/max       | 0.4 / 0.7              | 9.6 / 13.9                | 108.2           |
| Baseline C  | 4 / 4 min/max       | 1.2 / 1.9              | 10.0 / 14.9               | 122.9           |

All are visible High / 100% / DRS off / sunny at 870×884 on NVIDIA. A and B
both end with 444 draws, 1,533,372 triangles and 104 shadow draws. C ends with
447 draws and 1,558,490 triangles (104 shadow draws); it is not an identical-geometry
repeat. GPU medians are 10.77 / 11.48 / 10.51 ms, so no GPU speedup is demonstrated.
The invariant reduction in traversals and narrow CPU benefit justify retaining the
candidate. Persistent >100 ms callback gaps remain unresolved; this does not establish
smooth combat or AAA acceptance. Other user Chrome game tabs were not closed.

Regression tests failed on the old path (eight versus two updates across two moving
frames), then passed on the candidate. Twenty-four post/depth/shadow tests pass;
types and production build pass (5.05 s, 263 modules, index-Dl0BrTHP.js). Scoped lint
passes after removing an unnecessary assertion in a test. Existing bundle-size
warning remains. Baseline/candidate screenshots are retained in the Oct 8 capture
directory. Full receipts: `tools/assets/build/market-frame-profile-before-20261008.json`,
`market-frame-passes-before-20261008.json`, and `market-matrices-{baseline-a,candidate-b,baseline-c}-20261008.json`.

Next: observe browser long frames from both parent and iframe (the original iframe
observer reports no long-animation-frame entries; this alone does not rule out browser
scheduling). Reassess any next optimization against measured cause rather than dropping
detail or disabling AO.

A fixed upper-Palace screenshot region [285,80,835,240] differs by mean 0.0333
RGB levels on a 0–255 scale; its p95 absolute channel difference is zero (maximum
30). This supports narrow static visual preservation; animated leaves/weapon are
excluded, and JPEG captures do not establish whole-scene pixel identity.

Preservation check: branch `codex/isolated-finish`, main HEAD
`cb35f065f7b5b78a2e38a61bc61a321fc5c6244e`, all seven recorded Claude SHA256s match.
No commits, pushes, user-tab closures or paid cloud jobs occurred.

Final sample D includes the integrated window changes: 683 frames, world updates
1/frame, matrix median 0.4 ms / p95 0.9 ms, frame median 9.8 ms / p95 18.7 ms,
callback p95 108.4 ms, GPU median 10.24 ms. Counts match A/B (444 draws,
1,533,372 triangles, 104 shadow draws), with zero hidden frames. It is a later
uncontrolled repeat, not a causal performance comparison for the window shader.

Parent-observed long-animation-frame entries now reveal 78 long frames; the iframe
observer reports zero. Attribution is Three's onAnimationFrame callback. Early
examples have 109–146 ms total duration versus 10–38 ms script duration, with zero
reported forced layout/blocking duration. This narrows the next investigation to
browser rendering/presentation and GPU submission, without proving which browser
or external workload causes it. Three unique long tasks appear in both scopes
(six records); do not double-count them as six independent tasks.

The normal branch menu at 5174 is ready on Market and connected (1 ms). A console
MutationObserver TypeError has no supplied source; no MutationObserver use is found
in client source/HTML. Its origin remains unassigned rather than attributed to game
code. No black-frame shader failure is observed in the captures or ready menu.
