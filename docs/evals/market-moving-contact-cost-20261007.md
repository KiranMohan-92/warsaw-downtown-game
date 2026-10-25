# Market moving foot contact and query cost — 2026-10-07

Previous goal turn classification: progress. Remote gunfire implementation, actual
hall cover regressions and a rendered WAV changed authoritative state/evidence.
The isolated Vite process was directly polled live again at the start of this turn.

Acceptance before edits:

- Drive the actual Market character controller and shipped Soldier rigs up and down
  hall stairs using fixed 60 Hz simulation with 30/60 Hz presentation schedules.
- Record actual sole support, head/gun/root alignment, finite transforms and terrain
  callback counts separately from diagnostic vertex measurements. CPU test timing
  is not browser frame time. Keep floating/penetrated samples in the report.
- Preserve a before receipt before optimizing. Reject contact-position/quaternion
  differences above 1e-6 between identical before/after inputs; reduce queries only
  where remaining sole points cannot improve the existing squared-distance score.
- Retain all fallback rings when no valid nearby plant exists. Keep current swing,
  idle caching, terrain query, authoritative root and special-stance behavior.
- Run existing stationary/moving rig regressions and types/lint/build. Record any
  continuous traversal contact failures rather than substituting settled poses.

The initial ring-cost hypothesis was rejected by complete source inspection: search
already exits after the first successful ring. The measured baseline nevertheless
spends up to 1,099 support calls in one update. The candidate's `raise` is a running
maximum. Once it exceeds .4 m, later points cannot restore validity. Once it is
nonnegative and `radius² + raise² >= best`, later points cannot improve the strict
score. Skip only the rest of those rejected scans; keep every potentially better
candidate and all rings needed when no target exists. Compare exact bones/feet to
the before receipt. This assumes the production support callback is a pure query
on the same world within one update.

## Improvement 23 results

The 864-frame paired controller probe preserves every recorded root, bone quaternion,
world joint position and foot metric exactly (maximum numerical difference 0). Support
queries fall from 129,578 to 129,022 (0.429%); median 78, p95 658 and maximum 1,099
are unchanged. This is a small saving, not a demonstrated frame-rate improvement.
Three focused files passed all 17 tests in 66.34 seconds. Types and scoped lint passed.
The production build passed (262 modules, 3.77 seconds); its large-chunk warning remains.
Raw before/after and comparison receipts are in tools/assets/build/soldier-traversal-*.

The 10.649 mm downward-traversal penetration at tick 23 is airborne: grounded=false
and updateQueries=0. The Soldier flight gate bypasses FootPlant. It is not a failure
of the candidate prune, and the airborne animation is not being forced onto terrain.
Continuous movement and whole-game visual acceptance remain open.

## Improvement 24 acceptance before edits

Reuse per-vertex sole scratch vectors to reduce temporary objects during terrain scans.
Keep the candidate outline independently owned: contact() resamples the same scratch
vertices during search, so aliasing would silently change subsequent candidates.
Retain vertex order, thresholds, terrain query order, stance gates and contact results.
Compare the same 864 controller frames against accepted after23 with <=1e-6 numerical
difference, identical support counts, and run stationary/moving regressions, types/lint/build.
No browser FPS claim follows from source-level allocation removal.

## Improvement 25 acceptance before edits

The hall stair run ends at x145.6, while the landing ends at x144.8. Close this
0.8 m gap with a continuous visible landing, without adding hidden foot surfaces
or changing flight animation. First prove the old gap with downward visible rays.
Then verify visible tread support throughout the connection and actual fixed-step
controller traversal up/down, including finite positions, landing/floor endpoints
and no extended airborne interval at the old gap. Re-run moving boot regressions
and report any remaining penetration, rather than treating geometry alone as proof.

## Improvement 24 results

Each sampled sole vertex now owns a reusable scratch vector. The selected outline
keeps independently cloned extrema because candidate evaluation resamples those
vertices. The paired 864-frame receipt has zero pose/contact/query differences
against after23. Support calls remain 129,022. Three files passed all 17 tests in
56.58 seconds before the map correction; the final combined run also passes.
This removes temporary vertex objects; no allocation count or browser FPS gain
has been measured.

## Improvement 25 results

The old connection failed the new visible-surface and controller regressions:
two tests failed and one passed (37.32 seconds). A downward ray in the gap hit the
ground instead of the upper landing; upward traversal spent three consecutive
ticks airborne. A read-only diagnosis confirmed that the foot solver was bypassed
by its correct grounded gate during the failing downward frame.

Extending the entire stair run was rejected: it changed tread spacing and broke
stationary sole-clearance acceptance. A first version also exposed an exact-edge
ray seam; a 1 cm overlap repaired that seam but not the changed boot clearance.
The accepted change preserves the existing 5.4 m flight and all 19 tread positions.
It extends the visible upper-floor landing to the top tread with a 1 cm overlap.
Both rendering and collision use that geometry; no support-only surface was added.

Tests now derive settled stair roots from the actual current Market controller
instead of a dated receipt. The continuous 864-frame probe uses both shipped rigs,
60 Hz simulation and 30/60 Hz presentation. Before the landing correction it
recorded 16 airborne frames, 18 frames with neither sole supported, and maximum
penetration of 10.649 mm. Afterward those counts are 0 and 0, with maximum measured
penetration 4.996 mm. Head, weapon and authoritative root alignment checks pass.
These results cover the tested route/poses, not every combat animation or network
interpolation case. The map change alters controller trajectories, so its query
count is not an equivalent-input performance comparison.

Final verification: four files / 20 tests passed in 137.86 seconds. After a small
test-only declaration lint cleanup, the affected moving-contact test passed again
in 48.88 seconds (one selected, one skipped). Types, scoped lint, formatting and
diff whitespace checks passed. Production build passed: 262 modules, 3.39 seconds,
index-DwTPFQiN.js 8,095.56 kB / gzip 3,045.99 kB. The large-chunk warning remains.
The raw traversal receipt fingerprints the production foot solver and map; its
test hash predates the declaration-only cleanup. The adjacent ledger records both
the tested receipt and final source hashes rather than equating those snapshots.

## Captures, preservation and retrospective

Final-preview lighting follow-up acceptance: the stair correction changes the
lightmap layout and the old bake is skipped. Re-bake locally in this isolated
worktree with the existing 64 samples / 16 m reach. Require the bundled-bake
regression to select both the static atlas and lamp volume, matching generated
JSON/TS manifests and image dimensions; require no stale/skip warning in a fresh
actual-game view. Retain prior screenshots as pre-rebake evidence and capture
updated fixed views. The README's main-only integration convention is overridden
by the user's explicit isolated-branch constraint; this writer owns all outputs.

Lighting follow-up results: the local bake completed in 333.0 seconds on four
workers with zero trapped rays. Layout is 1f8605625ccbab, scene 10a65919c6a0f5.
Generated JSON/TS hashes match; atlas, ground, lamp and volume PNG dimensions match
their layouts. All eight lightmap tests passed in 8.63 seconds, including selection
of the bundled Market bake and lamp volume. Types and scoped generated-manifest lint
passed. The updated production build passed: 262 modules, 4.62 seconds,
index-B5scae8F.js; bundle size is unchanged and the large-chunk warning remains.
A fresh reload after the completed bake reports no warning/error logs and reaches
the fixed High / 100% / DRS-off scene. Final 1280x720 native JPEG captures are
market-baked-hall-25.jpg, market-baked-forecourt-25.jpg and market-baked-neon-25.jpg
in the same capture directory. Earlier market-current-*-page.png files predate
the restored bake and remain historical evidence. The browser is back at the
playable Market menu, marked to remain open, with server connected (2 ms).

Three fresh supported browser captures show the actual game at High, 100% scale,
DRS off: hall-to-Palace day, forecourt day and hall night. Files are under
C:/Users/kiran/myprojects/gameplay-captures/2026-10-07/market-quality/ with names
market-current-hall-page.png, market-current-forecourt-page.png and
market-current-neon-page.png. They include review controls and the HUD. They also
resolve the earlier final one-profile Palace screenshot omission; they do not
prove CPU optimization visually or establish AAA quality. The native capture API
succeeded after browser/account recovery. The alternative local canvas receiver
saved no file and was stopped; its unused dev-only button/helper was removed.

The isolated preview runs on 5174 with server 2568. The browser is back at the
Market menu and reports server connected. Main HEAD remains
cb35f065f7b5b78a2e38a61bc61a321fc5c6244e; all seven preserved Claude-file hashes match.
No commit, push or Modal job was performed.

One writer integrated a bounded read-only diagnosis. First-pass acceptance: 23 and
24 passed their paired checks; 25 required two rejected stair-run variants before
the landing extension passed. Rework corrected geometry and stale test poses;
browser loading/approval failures were environment failures, not code regressions.
Observed test/build durations are retained above; total task elapsed time and cost
are unknown. No sequential comparison or delegation speedup is claimed. The
useful lesson is to fix actual visible collision gaps before widening IK reach,
and to settle test poses against current geometry. Whole-map art, distant object
acceptance and combat frame pacing remain open.
