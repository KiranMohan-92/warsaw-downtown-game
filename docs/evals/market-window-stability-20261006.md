# Window stability pass

Acceptance before editing, improvement 19, isolated codex/isolated-finish only.

The current room shader computes derivatives after a varying window-mask return, uses
hard cutoffs for mullions and blind slats, and divides room rays by unguarded components.
The pass must keep window layout and interior parallax, avoid NaN for parallel rays,
compute derivatives before divergence, filter subpixel frames/fabric, and preserve
collision, silhouette, draw count, assets and saved settings. No sharpening of subpixel
noise or distance-based removal of room detail. New cache keys must invalidate shaders.

Verification: shader composition checks against Three's actual standard source; real
game day/neon renders at the hall and forecourt with no shader errors; relevant tests,
types, scoped lint and build. Evaluate appearance honestly; a shader pass alone does
not prove whole-Market AAA quality or a performance gain. Frame pacing and physics
review findings will be recorded separately. Main and preserved Claude hashes must match.

Improvement 20 acceptance: resolve the reproduced raised-ankle toe penetration (3.43 cm)
using only a vertical clearance correction. Clean raised swing feet must retain the original
ankle position and sole gap; hips, root, head and held weapon must stay aligned. Preserve
the previous report; write a separate after-20 receipt and verify both real rigs plus stairs.

Improvement 21 acceptance: give Palace windows two shallow stone surround profiles in
near LOD, within the existing keep-out and -0.3..0 m collision envelope. Retain the exact
glass openings, hood/sill geometry, segment seams, medium/far layout and block style.
Merge into existing material draws. Measure the extra triangles and geometry memory on
the actual Market; reject a greater than 15% facade triangle increase or new draw calls.
Compare the saved forecourt pose at 1280×720. This is additional architectural detail,
not a change to collision or a claim that the Palace is photorealistic.

## Current evidence

Improvement 19: derivatives moved before window/frame divergence, exact pixel-strip
coverage for mullions, integrated blind slats and box-filtered curtain folds. Parallel
room rays have finite fallback exits. The new shader key distinguishes this program.
Three focused files passed 28 tests in 35.14 seconds; typecheck and scoped window lint
passed. The fresh real-game review reported no error logs. No additional downloads,
vertices or draw calls are required by this shader change.

Improvement 20: an ankle above the swing threshold now receives an actual low-sole
penetration check. A penetrating toe gets a vertical-only correction without acquiring
a plant target. Clean raised feet keep their original position/gap. The moving probe
and leg solver passed 3 tests in 16.69 seconds, including <=8 mm penetration and hip,
head, gun and root preservation. The preserved before report is unchanged; the new
receipt is tools/assets/build/soldier-moving-contact-after-20-20261006.json. Continuous
character-controller stair navigation, every combat pose and runtime cost are not
established by the 128-frame sample.

The first all-storey two-profile stone surround
failed the cost gate: near source quads 154,540 -> 251,052, ratio 1.6245. Geometry bounds,
LOD layouts, seams and existing stationary soldier tests passed in that run (53 passed,
one budget failure, 52.38 seconds). A three-storey revision also failed (ratio 1.1866).
Both rejected receipts are preserved in tools/assets/build/. The current revision
limited hand-scale geometry to the bottom two storeys and kept room shading on upper
windows. Its source-quad check passed at 1.1267, but the actual merged visible triangle
check failed at 1.1875. The source-quad gate alone cannot prove GPU cost.

The accepted geometry revision uses one stone surround profile on the bottom two
storeys. Final source quads are 154,540 -> 162,070 (4.87%). Actual merged facade buffers
are 36,924,718 -> 38,791,534 bytes (1,866,816 additional bytes). In fixed High-tier model
camera poses, hall facade triangles are 112,179 -> 121,739 (8.52%), and forecourt
triangles 129,852 -> 139,932 (7.76%). Both stay within the unchanged 15% limit. Three
material draws and the 2,986-triangle shadow proxy are unchanged. These are actual
Market mesh measurements, not whole-game GPU timings. The two final geometry files
passed all 42 tests in 23.86 seconds. The preceding six-file run passed 60 tests and
failed only the rejected geometry's cost check; window and moving/stationary contact
source is unchanged since that run. Production build passed: 261 modules, 2.82 seconds,
index-CRsc9i_r.js 8,094.68 kB / gzip 3,045.69 kB. Final types and scoped lint passed.

Screenshots in gameplay-captures/2026-10-06/market-quality/ include the fixed 1280x720
forecourt baseline market-window-before-21-forecourt.png and provisional current view
market-window-after-21-prototype-forecourt.png. The still-image difference is modest;
it does not establish AAA architecture. A runtime error report is empty in this view.

The read-only renderer review found one redundant camera inverse, but no justified
render-pass removal beyond the already-fixed AO/shadow path. No speculative performance
optimization was applied. The earlier p95 frame-pacing failure remains unresolved.

Execution notes: the explorer model was unavailable; a read-only debugger replaced it.
The browser recovered from a transient navigation timeout without restarting the live
5174 process. Binding an old error-page tab was rejected by browser URL policy; no
workaround was attempted. Shell command cells 227 (cost check), 228 (read-only inspection)
and 230 (record update) completed after the interruption, and their results were read
before further work. Cell 232's actual test process also completed; its failed cost
check triggered the single-profile correction above. Isolated Vite session 52941 was
directly polled and confirmed live. No main edits, commit, push or Modal job. An explicit Modal spending
cap was requested asynchronously and has not been supplied.

On 2026-10-07, the final one-profile screenshot could not be saved: both supported
browser screenshot methods failed to capture pixels, including another attempt in
the current visible review tab. DOM inspection still showed the review ready.
The saved two-profile prototype is not evidence for the final geometry. Screenshot
delivery for this three-improvement group remains pending. Main HEAD remains
cb35f065f7b5b78a2e38a61bc61a321fc5c6244e and all seven preserved Claude hashes match.

Final runtime recheck: the actual game loaded at the restored default viewport in sunny and neon presets, with no error/warning logs reported by the review tab. Screenshot capture still failed at that viewport; no final pixels were saved. The browser was returned to the branch menu and marked to remain open. Isolated Vite session 52941 stayed live; the audio artifact helper exited after its one save.

2026-10-07 capture addendum: supported native screenshots subsequently succeeded.
The accepted final one-profile geometry is visible in market-current-hall-page.png,
market-current-forecourt-page.png and market-current-neon-page.png under
C:/Users/kiran/myprojects/gameplay-captures/2026-10-07/market-quality/. The forecourt
uses the same fixed camera and High / 100% / DRS-off sunny settings as the baseline.
These are actual-game views with HUD/review controls, not the rejected two-profile
prototype. Screenshot delivery is now resolved. Prior frame-pacing and architecture
limitations remain; the images do not establish AAA quality.

After the later stair correction, Market lighting was re-baked locally to match the
new layout. Final current views with the restored bake are market-baked-hall-25.jpg,
market-baked-forecourt-25.jpg and market-baked-neon-25.jpg in that directory; use these
for current visual review. See market-moving-contact-cost-20261007.md for validation.
