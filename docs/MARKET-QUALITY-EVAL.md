# Market quality evaluation — 2026-10-05

Scope: `codex/isolated-finish`, browser rendering and local/server-authoritative gameplay.
Main and the Claude worktrees remain preserved. AAA is an artistic target, not a
certification conferred by unit tests or increased image resolution.

## Next pass acceptance — presentation occlusion and GPU bake coverage

Explosion occlusion must ignore hidden movement helpers while still finding a
visible wall behind them; changing only a hit's visibility flag is insufficient.
Use one filtered Rapier query per queued blast, retain the 64-blast cap and
listener timing, and leave bullet/movement queries unchanged. Verify open paths,
hidden-only paths, hidden geometry before visible walls, range bounds and actual
Rapier surfaces. Ground-contact rendering must place its cue on rendered support,
not on invisible ramp helpers, without moving authoritative actors or hitboxes.

Extend the existing optional Modal workflow to stage both ground and static
receiver atlas bakes with strict CUDA/input/output/receiver provenance and resource
bounds. Preserve ground defaults, require the existing explicit spending limit,
and do not publish assets or claim remote execution from mocked tests. Investigate
actual Market grounding separately before proposing mesh offsets. This pass must
retain main/Claude hashes and produce a source-backed evaluation record.

## Acceptance checks defined before this pass

| Area                 | Required evidence                                                                                                        | Pass condition                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Isolation            | Main HEAD/status and seven preserved-file hashes                                                                         | No change from recorded original snapshot                                                                       |
| Graphics correctness | Fixed-pose daytime/neon views; shader/material tests                                                                     | No doubled exposure, color-space error, lighting leak, missing surface, or stale bake applied                   |
| Performance          | Active, foreground NVIDIA gameplay, fixed settings/viewport; warm-up followed by movement/combat frame-time distribution | Record actual median/p95/p99 and draws/triangles; target 60 fps, p95 <= 25 ms; menu/background samples excluded |
| Startup              | Cold/warm load to playable state and shader count                                                                        | Record measured time; no claim based solely on asset-byte count                                                 |
| Movement/physics     | Deterministic actual Market collider tests for ramps/stairs/cover, collision, projectiles, and different frame schedules | No penetration/tunnelling or frame-rate-dependent gameplay; client/server contracts agree                       |
| Audio                | Distance/occlusion/room transitions, impact/step matching, overlap/headroom and cleanup tests; listening review          | No missing room routing, clipping, discontinuities, or unbounded live nodes                                     |
| Modal bake           | Exact scene/input hash, bounded job contract, CUDA receipt, linear image analysis, runtime gating                        | Remote execution must be proven; mock tests and local Cycles output do not count as Modal success               |
| Art quality          | Comparable landmark captures and independent visual critique                                                             | Cohesive lighting, convincing surface scale/variation, believable silhouettes; unresolved gaps recorded         |

## Baseline observations

- Chrome gameplay overlay confirms ANGLE NVIDIA Quadro T2000 with Max-Q Design,
  Direct3D 11. The persisted high-performance GPU switch survives restart.
- Menu observations: about 610 calls / 2.374 million triangles, 226 programs,
  High at 100%. These are inventory observations, **not an active-play benchmark**.
- Existing Cycles output covers only the Palace cyan sign's flat entrance receiver,
  256 squared, CPU. Whole-Market sky AO and indoor lamp atlases are local analytic
  ray bakes. No successful Modal receipt has been found.
- Most Market landmarks have no Cycles colored bounce coverage. Merely enlarging
  the Palace image leaves that gap unchanged.

## Execution record

This pass begins with independent read-only rendering, physics/audio, and asset
pipeline audits. One writer owns each implementation area; integration and final
snapshot checks remain with the lead. Costs, acceptance/rework rates and elapsed
times remain unknown until measured. Prior district-pass frame timing is not a
comparable NVIDIA baseline and is not used to claim a speedup.

Status: audit and bounded implementation in progress. AAA equivalence and the
performance target remain unverified.

## Implemented bounded improvements

- Market district detail uses nearest mesh bounds and quality-specific distance
  hysteresis, preserving map colliders and restoring detail at Ultra.
- Nearby impact and explosion chips sweep against the shared Rapier world, bounce,
  damp and settle. Fixed particle pools and at most 96 active world-colliding
  particles bound the work. Overflow remains presentation-only analytic debris.
- Airborne blasts produce fire/smoke without unsupported floating scorch marks.
- Blasts use stereo pan, distance delay (capped at 350 ms), a single cover ray,
  muffling and continuous distance attenuation across the near/far clip boundary.
  This is not full HRTF, diffraction, room acoustics or structural destruction.
- Actual NOCNY RYNEK ground illumination is installed from local CPU Cycles:
  306 meshes / 114,336 triangles, 512 squared / 128 samples, 28,269-byte PNG,
  25.589-second bake, zero clipping. Runtime validates map and sign compatibility,
  handles failed/late uploads and replaces the old sign glow only on success.
  Source freshness is enforced by installation, not by runtime source hashing.
  Coverage is one ground tile, not the whole Market or dynamic actors.

## Current verification and remaining evidence

- Combined focused rendering/audio/effects checks: 10 files / 64 tests passed; the later camera-queue tests add 2 passing checks.
- Shared movement/clipping/prop impact/hull checks: 4 files / 32 tests passed.
- Asset pipeline author verification: 32 Python tests (including earlier bake
  helper regressions) and 3 Node exporter tests passed.
- Types and scoped ESLint passed. Browser production build passed with existing
  large bundle warning (main script about 8.07 MB, gzip 3.03 MB).
- Main HEAD remains cb35f065f7b5b78a2e38a61bc61a321fc5c6244e, with only the recorded
  export_mannequin_tpose.py and tools/handoff untracked files. All seven original
  main/Claude file hashes matched on 2026-10-05.
- Blast audio queues source snapshots and flushes after the current camera pose is established; moved-camera, queue-limit and cleanup checks pass.
- Modal execution remains pending the explicit user spending limit. No cloud job
  or paid GPU bake was launched in this pass; cloud costs are unknown.
- Foreground GPU timing, cold/warm startup, overlap/headroom listening and
  independent AAA art assessment remain unverified. Browser source-edit reloads
  interrupted earlier asset loads; those views are not performance baselines.

## Retrospective

Two integration corrections were required: a material test expected the old
shader key, and the sound near/far switch raised clip gain. The audio review also
caught camera-pose timing. Collision assignment was changed to a global active
cap so assigned physical particles cannot starve behind earlier particles.
A helper initially edited outside its assigned files and wrote a placeholder
manifest; the lead stopped those edits and the strict installer replaced the
placeholder with the validated reference. Maintain explicit file ownership and
use generated contracts before runtime integration in future passes. No measured
cost or comparable sequential baseline exists; no speedup or acceptance-rate
claim is made.

## Visual/performance pilot result

Same-pose branch captures are saved in
`C:/Users/kiran/myprojects/gameplay-captures/2026-10-05/market-quality/` as
`neon-bake-before.png` and `neon-bake-after.png`. The before comparison disables
only the new landmark bake and restores that sign's original ground card; it is
not a fresh main-branch comparison. The actual explosion preview was exercised
through the review control, including five presentation-only blasts.

Independent read-only image critique: colored pavement is a visible improvement,
but illumination reads as a broad tile. Convincing falloff, blocked-light
footprints/contact shadows, light on vertical surfaces and whole-market coverage
remain open. This pilot does not establish AAA art quality.

Chrome reports the NVIDIA renderer. The 8-second requestAnimationFrame probe
returned 14 intervals, median 1013.3 ms, p95/p99 1013.6 ms, document visible/focused.
OS occlusion is unknown, and camera was stationary. This is a failed/invalid
candidate for a smooth-gameplay claim, not GPU frame time or an accepted movement/
combat benchmark. The observation is preserved in `review-observations.json`.
Resolve actual foreground timing and power/occlusion behavior before claiming
60 fps or expanding real-time effects. No comparable prior run establishes speedup.

Camera correction review found no production blocker, but typed test mocks were
required to clear ESLint. The final scoped queue checks, typecheck and lint passed.

## Follow-up acceptance — solid debris and measurement integrity

Before editing this follow-up: retain three debris draw submissions, the existing
384/128/256 pool capacities and at most 96 assigned physical sweeps. Solid bits
must be actual lit geometry with surface-specific aspect ratios, finite tumbling
transforms, stable settled orientation and bounds that fit their collision radius.
No map or shared gameplay change is permitted.

GPU timing must discard old samples and outstanding queries on a resize or
disjoint event, reject non-finite results, and report unavailable timing explicitly.
These checks establish measurement correctness, not frame-rate or AAA acceptance.

Read-only asset audit: 133 runtime/manifest files (15,825,723 bytes), all 42 glTFs
and 45 external references are complete with valid buffer ranges. Thirty-five
HTTP checks returned 200 and exact branch-file hashes, including repeated reads
of the previously failing hero/prop buffers and HDR. Current missing files or
routing are not indicated; browser reload cancellation remains an unproven cause.

Follow-up implementation: solid bits now share one lit instanced chip mesh with
wood/stone/glass/metal aspect profiles, airborne tumble and fixed settled rotation.
Their transformed bounds fit the 35 mm collision radius; source-plane clearance
uses that full radius. The final 15% of life shrinks geometry before recycling.
Dust and sparks remain point pools. The chip color/matrix buffers are preallocated,
and one out-of-view chip is drawn during boot warm-up, then restored without live
particle additions. This remains presentation collision, not rigid-body fracture
or transparent-glass rendering.

GPU reset/disjoint handling now invalidates old samples and pending queries, so
results from the previous resolution cannot feed current dynamic-resolution
decisions. Invalid query results are rejected. The debug snapshot exposes GPU
median separately from compositor FPS; unavailable timing is null.

Focused integration verification: 7 files / 60 tests passed. Types, affected-file
lint/formatting and browser production build passed (main script 8,072.34 kB,
gzip 3,036.24 kB; existing chunk warning remains). Read-only review found no
correctness blocker in GPU/DRS/warm-up wiring. Main HEAD/status and all seven
preserved hashes still match.

A pre-final-reload browser observation reported NVIDIA, 575 calls, 2,160,675
triangles, 228 programs, GPU median 47.32 ms and 4 compositor FPS. OS occlusion is
unresolved; a later hardware sample showed 2.99 W / 0% GPU utilization, and the
laptop reported battery status 1 with 60% charge. These are separate observations,
not an accepted steady foreground benchmark or evidence of a speedup. Cloud jobs
remain unlaunched while the explicit spending-limit question is pending.

Rework: review caught lazy chip-color allocation, initial quaternion normalization,
geometry expiry and missing warm-up/settled-shape checks; those were corrected
before acceptance. No measured comparison supports a speedup or cost claim.

## Screenshot cadence — requested 2026-10-05

Show a fresh in-game screenshot after every three applied improvements. Preserve
the capture conditions and describe only what the capture actually establishes.
Current set: material-shaped chips, airborne tumbling with stable settling, and
softer mottled dust. The first two involve motion; a still cannot verify motion.

Dust now uses a cached 64 px mottled alpha texture with feathered transparent
edges, reduced luminance/opacity, and lifetime-correct fade-in/out. Sparks retain
their existing dot texture. Final affected debris checks: 2 files / 27 tests,
typecheck, scoped lint and formatting passed. The final production build passed
in 2.34 seconds (main 8,073.10 kB, gzip 3,036.67 kB; existing chunk warning).

Captures in `C:/Users/kiran/myprojects/gameplay-captures/2026-10-05/market-quality/`:
`material-effects-after-3.jpg` shows actual-size chips in an artificial four-material
inspection burst at 8% presentation speed, without damage. Bright round sparks
remain visible; this capture does not establish a finished explosion appearance.
`market-after-3.jpg` shows the wider Night Market after normal effect speed was
restored. High quality, 100% render scale, neon weather, isolated branch review
server; these are game-rendered views, not generated concept images. Console
warning/error list was empty for the stable final view. The HUD's server-offline
message refers to the absent multiplayer backend.

No main-branch comparison is implied by these two captures. Whole-map AAA quality,
foreground performance and a paid GPU bake remain open acceptance items.

## Next three improvements — sign and receiver continuity

Acceptance before editing: preserve sign placement, housing extents and emitter
specifications; sharpen readable sign artwork with correct sRGB canvas colors and
stable physical dimensions. Housing hardware adds at most two instanced batches
and 1,200 triangles, with disposal covered. No new real-time lights are permitted.
The same baked world-space illumination must reach visible grass ground layers,
without applying the Palace courtyard bake to grass or lighting elevated foliage.
Re-export/rebake after the sign authoring source changes, retaining exact source
provenance. Verify affected shader/material tests, types, lint and production build,
then capture the same Night Market pose for comparison and a sign detail view.

Read-only diagnosis: the installed PNG contains falloff and obstacle shadows;
UV orientation, linear decoding and E/PI conversion match the emitter. The visible
hard rectangle follows grass overlays, which currently do not receive the neon
hook while the underlying street does. Correct receiver coverage before changing
bake intensity. These changes do not prove whole-map AAA quality or performance.

Applied set (improvements 4–6): proportional 1024 px sign artwork uses original
sRGB bytes for CSS color and fitted text, without animated panel stretching.
One shared housing-hardware batch adds 40 instances / 480 triangles / one draw;
existing emitter placement and housing mesh remain unchanged. Grass now receives
the same world-space neon bake as hard ground, with the existing ground-height
and upward-facing gates; Palace courtyard illumination still excludes grass.

Final checks: material/receiver tests 19 passed, sign tests 7 passed, types and
scoped formatting/lint passed. The exporter tests (3) and offline pipeline tests
(21) passed. A previous grass shader-key expectation required correction to match
the added receiver hook. Combined production build passed in 8.80 s; main script
8,075.13 kB / gzip 3,037.30 kB, with the existing chunk-size warning. No full FPS
or startup acceptance was inferred from this build.

Refreshed source input `scene-sign-continuity.json` SHA256:
`cc6fc40fdf2a2bbb95005f2250784597c05982def74f7397cd06934ef545974f`.
Local CPU Cycles: 512 px / 128 samples, 306 meshes / 114,336 triangles,
10.572 s measured bake time, zero clipping, 28,269-byte output. Geometry/emitter
specifications and output image hash are unchanged from the previous reference;
the strict installer refreshed source provenance. The sign still emits a uniform
calibrated panel in the offline bake; individual letter emission, casing hardware
occlusion and vertical bounce are not represented. No Modal job was launched.

Fresh capture `market-after-6.jpg` uses the same Night Market pose, High 100%,
neon weather and viewport as `market-after-3.jpg`. Stable final browser warning/error
list was empty, and all seven main/Claude preserved hashes matched again.
Independent image review confirms the grass cutoff is reduced and the sign frame/
main label are clearer. The sublabel remains soft; flat sign layering, broad paving
light shape, and missing colored bounce/contact detail on nearby vertical props
remain visible gaps. These are the next art acceptance targets. Still images do
not verify motion, foreground performance or whole-Market AAA equivalence.

## Next three improvements — vertical light, contact resolution and wet metal

Acceptance before editing (7–9): bake scene-bound colored illumination onto actual
nearby static box faces using the existing atlas UV1 layout. Exclude models,
dressing and specialized geometry that cannot use that layout. Unbaked atlas
slots must remain black; geometry/layout/emitter mismatches must disable the
addition. Chain after sky AO, preserve ceiling-lamp lighting and wetness, and add
no lights, passes, geometry or draws. Allocate at most 32 MiB for the sparse RGBA
atlas, without mipmaps, and upload before shader warm-up. Verify UV correspondence,
linear decoding, cancellation/disposal and weather/Low-tier gating.

Rebake the ground at 1024 px / 128 samples to halve the landmark's world-space
texel pitch and resolve prop-base shadow edges more finely; retain the existing
linear radiance scale and exact obstacle/emitter scene. Inspect this as contact
resolution, not new physics or additional occluder coverage. Sign metal uses the
existing rain/shelter wetness response, preserving dimensions and all resource
counts. Refresh strict source provenance after sign-source edits. Run affected
tests, types, scoped lint/formatting and the production build, then capture the
same Night Market pose plus a container detail. Main/Claude preserved hashes must
still match. No Modal job is authorized by the unresolved spending-limit question.

## Player-reported distant blur / floating — acceptance before editing

Keep readable props in their full mesh when their projected height remains at
least 24 internal-render pixels, including zoomed and elevated viewpoints. Use
6 px and existing 6 m hysteresis to avoid toggling. Reuse existing meshes/materials
and shadow proxies; no per-frame allocations or extra batches. Optional projection
input absent/invalid must retain the existing distance-only behavior. Ground-anchor
alignment requires real asset evidence before adjusting a model's Y position.
Actor feet must be checked against animation/pose placement; do not lower every
actor or alter authoritative simulation/hit volumes for missing shadow cues.
Reduce night haze only enough to retain at least 80% scene contrast at 120 m,
preserving the existing weather colors and near atmosphere. This is not proof of
native resolution on the user's Chrome, nor a guarantee of AAA far-field detail.

Applied improvements 7–9: sparse 2048 × 1560 static neon atlas covers 39 real
box receivers (concrete, container, wood). It chains after the existing AO/lamp
material hook, adds one atlas lookup and no geometry/lights/draws, and is excluded
from plain Low materials. Linear texture allocation is 12,779,520 bytes without
mipmaps. CPU Cycles 128 samples took 80.801 s; PNG 25,209 bytes, zero clipped
channels, texture SHA256 `59521c2db3bb0a0e13a8db5073fcbb5216e8274bbc2018ac710d583c790e84b1`.
Ground reference increased to 1024 × 1024 / 128 samples: CPU bake 132.341 s,
95,123-byte PNG, zero clipped channels, SHA256
`d345f44ad4ebf0a0471de99bd0c0a4fdb2f0347a8fe417db1f01d9065f1442ed`.
Wet sign housing/support uses the existing rain/shelter material response.

Applied improvements 10–12 for the reported distant view: prop mesh and shadow
retention now use projected size at the actual drawing-buffer height and camera
FOV, including zoom. Existing distance/pixel hysteresis avoids switching chatter.
Neon FogExp2 density is 0.0035 (120 m contrast transmission ≈83.8%). A pooled
contact-shadow draw supports up to 64 distant grounded actors and follows the
actual static-world support point/normal. It skips unsupported/airborne/seated/
board-riding/dead actors, steep surfaces and support gaps above 0.25 m. This is a
soft ground-contact cue, not a replacement for full directional shadows. Actor
simulation/hit volumes/Y placement remain unchanged; shipped animated boot bounds
were checked before choosing this fix. No general lowering offset was added.

Verification: eight affected client suites passed 92 tests. Types, scoped lint,
formatting and production build passed; build 3.33 s, main script 8,084.77 kB /
gzip 3,042.39 kB, existing chunk-size warning. Both Python bake pipeline checks
passed 22 tests; static exporter passed 3 tests. One real-map integration test
initially exceeded 20 s during concurrent CPU baking; its test-only deadline is
60 s and its loader is stubbed. An invalid option/type narrowing in that new test
was corrected before final type/lint checks. Seven preserved main/Claude file
hashes still match; main HEAD `cb35f065f7b5b78a2e38a61bc61a321fc5c6244e`.
No commit, push or paid Modal job was performed.

Captures: `market-after-9.jpg`, `palace-after-12-diagnostics.jpg`,
`palace-after-12.jpg` under the dated gameplay capture directory. The diagnostic
window view reports three supported distant actor contacts. Render statistics
identified NVIDIA Quadro T2000 Max-Q; the review uses High with 100% scale and DRS
disabled. A current single FPS reading is not a motion/performance acceptance.
The initial window capture used a different pose/viewport and is not a valid
before/after comparison. Reload-time asset fetch warnings occurred during source
edits; stable rendering still needs broader gameplay acceptance. Whole-map AAA
equivalence, multiplayer motion and every possible floating-object report remain
unproven. The temporary review is closed after capture; playable isolated server
5174 is restarted and retained.

Distance follow-up verification (2026-10-05, 23:27 local): reran propModels,
actorContactShadows, weather and soldiers suites together: 4 files / 54 tests
passed in 42.60 s. Playable isolated endpoint 5174 returned HTTP 200 and branch
remains codex/isolated-finish. All seven preserved main/Claude hashes matched.
Chrome's previous game tab had been replaced; subsequent browser inspection
timed out before a fresh resolution/screenshot check could complete. No new
native-resolution, performance or all-object-grounding claim is supported by
this follow-up. The previously verified palace-after-12.jpg remains the visual
evidence; it must not be described as a new capture. Temporary review server
5192 was stopped, and no production source edits, commit, push or Modal job
were performed during this verification.

## Distance and support follow-up — 2026-10-06

Improvements 13–15: hero meshes now retain detail at the same projected-height
thresholds as regular props (enter 30 pixels, retain 24 pixels), using the actual
drawing buffer and zoom FOV. Decoding the shipped Meshopt assets exposed far-mesh
base drift: burnt car 23.521 mm, food truck 5.108 mm, kiosk 1.654 mm. The loader
aligns only these body models' far positions to their near base, preserving packed
normals, UVs, indices, X/Z and dimensions. Unexpected drift over 5 cm fails before
upload. Other hero types and authoritative colliders remain unchanged.

Presentation rays now filter invisible movement helpers inside the Rapier query.
Contact shadows reach the rendered ground/treads behind a helper, and blast
occlusion still reaches a real wall behind it. Gameplay and movement rays retain
their original behavior. A legacy raycaster can reject an invisible hit but cannot
look through it; the current PhysicsWorld implements the full filtered query.

Verification: five affected TypeScript suites passed 48 tests, including real
Rapier hidden-helper/wall/floor cases and decoded shipped hero assets. The updated
atlas runtime suite passed another 6 tests. Type checking, scoped lint and
formatting passed. Production build passed in 2.47 s; main script 8,086.11 kB /
gzip 3,042.80 kB; the existing large-chunk warning remains. An initial asset
immutability check caught BufferGeometry.translate normalizing packed normals;
the fix now changes Y positions alone and the asset tests pass.

The Modal workflow now supports static receiver atlases as well as ground bakes,
with source/receiver/input/output fingerprints, bounded requests and CUDA device
validation. CUDA absence refuses CPU fallback. Twenty-two Python boundary and
device tests passed, using mocked remote calls/devices. These are not evidence
of a cloud GPU run or measured Modal cost. No paid job was launched. The refreshed
local CPU reference was validated and installed only on codex/isolated-finish:
2048 × 1560, 39 receivers, 128 samples, 11.236 s reported bake time, 25,209-byte
PNG, zero clipped channels. Texture hash remains
`59521c2db3bb0a0e13a8db5073fcbb5216e8274bbc2018ac710d583c790e84b1`;
input hash is `7e62bd3d9c0e9dada43607e77b9d4928977c2fd8d9e0f78c08f3633a4c81faa7`.
See tools/bake/MODAL-MARKET.md for the runner's limits and billing distinction.

Fresh screenshots under gameplay-captures/2026-10-06/market-quality include
palace-after-15.png and its diagnostics. The sunny review used High, scale 100%,
DRS off, a 1280 × 720 drawing buffer/CSS canvas and NVIDIA Quadro T2000 Max-Q
through ANGLE/D3D11. Document focus/visibility were true. This verifies the review
browser, not a fresh Chrome process. Three distant actor contact cues were active.
There is no same-snapshot before capture, so these are after views only.

An 8-second stationary sunny Market frame check at the Night Market sign pose
recorded 375 compositor intervals: median 16.6 ms, p95 49.9 ms, p99 66.5 ms.
The document retained focus and visibility; OS occlusion was not measured. A
separate GPU snapshot reported median 14.99 ms, 521 draws, 1,625,506 triangles,
233 programs. This is evidence of remaining hitches, not 60-fps acceptance,
combat performance or an isolated CPU/GPU bottleneck attribution.

The saved read-only root diagnostic tools/assets/probe-market-stairs.mjs settles
real Market capsules from above at six hall-stair points using fixed downward
requests. All six report grounded, but capsule-root/visible-tread gaps range
from 9.648 to 27.992 cm; the 2.5 cm support acceptance fails. Removing only the
hall's invisible ramp in an in-memory diagnostic map still leaves 16.168–20.706 cm
gaps. Results and source hashes are in tools/assets/build/market-stair-support-
20261006.json. This newer repeatable evidence supersedes the earlier unsaved
probe numbers and measures capsule roots, not animated feet. The capsule bridges
narrow step nosings. Foot/stance adaptation with head/hit-volume checks remains needed;
neither actor roots nor staircase collision was lowered as a cosmetic shortcut.
Far facade art, whole-map AAA equivalence, sustained moving/combat performance
and complete grounding remain unverified.

All seven preserved main/Claude file hashes matched; main HEAD remains
cb35f065f7b5b78a2e38a61bc61a321fc5c6244e. No commit or push. Playable branch
server 5174 was restarted after its endpoint had stopped and returned HTTP 200.
The snapshot ledger is docs/evals/market-distance-20261006.json.

## AO shadow preservation — acceptance before editing

Installed N8AO 2.0.1 transparency rendering temporarily changes mesh visibility
and calls renderer.render twice after the main shaded world pass. Three r186
refreshes shadow maps on each scene render when autoUpdate is true, so those
visibility-filtered auxiliary passes can clear/rebuild the world's shadow maps.
Reuse the main pass's current shadow maps during AO without changing enabled,
quality, shader parameters, geometry, resolution or gameplay. Restore both
autoUpdate and a pending needsUpdate flag even on exceptions. Verify one main
shadow refresh versus zero auxiliary refreshes with a representative renderer
test, test argument forwarding and pending/manual update modes, then run affected
pipeline tests/types/lint/build. Compare the same settled review pose and moving
firing script; record uncertainty rather than inferring a speedup from unrelated
single GPU snapshots. This does not solve stair animation reachability.

### AO shadow preservation — verified result (2026-10-06, improvement 16)

High/Ultra now use ShadowPreservingAOPass. A live review of the same loaded sunny
Market scene confirmed three eligible sun-shadow updates in the original behavior:
the normal world draw (232 visible casters), then AO masks (40 and 41 casters).
The preserved behavior had one eligible update from the complete world; both mask
draws reused it. Counts cover visible scene casters, not the shadow camera's final
draw list. The audit is saved in market-shadow-audit-original.json and
market-shadow-audit-preserved.json under the 2026-10-06 gameplay capture folder.
Quality, resolution, AO parameters and gameplay geometry were retained.

The targeted pipeline snapshot passed 21 tests in three suites, TypeScript,
ESLint and Prettier checks. The build at this review stage passed (3.17 s), with the
existing large-chunk warning: main bundle 8,086.30 kB / gzip 3,042.83 kB, file
index-CGHH6S5u.js. A static manifest was regenerated during review; its texture hash
remained 59521c2db3bb0a0e13a8db5073fcbb5216e8274bbc2018ac710d583c790e84b1,
and its compiled bundle identity matched the earlier build. No production
physics or rig compensation was changed in this pass.

Fixed 1280 × 720, High 100%, DRS off, sunny stationary checks used the same loaded
scene and pose, two seconds settling followed by eight seconds measuring:

| Behavior  | Frames | Interval median / p95 / p99 (ms) | Render wall median / p95 (ms) |
| --------- | -----: | -------------------------------- | ----------------------------- |
| Preserved |    326 | 16.7 / 33.3 / 33.4               | 21.1 / 28.8                   |
| Original  |    428 | 16.6 / 33.3 / 33.3               | 11.8 / 25.3                   |

These short sequential windows do not establish a speedup. GPU rolling snapshots
were 9.15 and 10.53 ms respectively and are not paired per-frame samples. Document
focus/visibility stayed true; OS occlusion, scheduling and thermal state were not
measured. Earlier after windows had large outliers (stationary max 2697.9 ms,
moving/firing max 502 ms), so their results remain saved rather than discarded.
The later fixed viewport protects comparison dimensions but does not explain
those outliers. Sustained 60 fps and full bot combat remain unverified.

Same-pose fixed-size screenshots are market-before-16-fixed.png and
market-after-16-fixed.png. These compare only AO shadow behavior on this branch;
they are not a new main-versus-branch comparison. The temporary review origin and
viewport override were removed; playable branch 5174 remains running.

## Supplemental unpaired AO timing windows

`ShadowPreservingAOPass` now freezes `renderer.shadowMap.autoUpdate` and
`renderer.shadowMap.needsUpdate` only while N8AO performs its own auxiliary render
passes, then restores both flags in `finally`. High and Ultra postprocessing use
that wrapper; N8AO quality, resolution, samples and shader parameters remain
unchanged.

The representative tests verify that the main scene render still refreshes
world shadows, while the transparent AO auxiliary renders do not trigger extra
shadow-map refreshes. The same tests cover pending manual shadow updates, disabled
auto-update, argument forwarding and exception restoration.

Same-harness High/100% sunny Night Market measurements, 1280 x 720 drawing buffer:

| Scenario           | Before interval p95 / p99 / max | After interval p95 / p99 / max | Before GPU median | After GPU median |
| ------------------ | ------------------------------: | -----------------------------: | ----------------: | ---------------: |
| Stationary handler |           50.4 / 66.5 / 83.1 ms |          16.9 / 17.0 / 33.2 ms |         38.219 ms |         7.604 ms |
| Moving and firing  |           49.9 / 66.4 / 83.1 ms |          33.2 / 33.3 / 33.3 ms |         43.388 ms |         7.519 ms |

After captures are saved under
`gameplay-captures/2026-10-06/market-quality/market-handler-stationary-after-shadow-preserving-ao.*`
and
`gameplay-captures/2026-10-06/market-quality/market-handler-moving-after-shadow-preserving-ao.*`.
These additional windows were collected by a helper concurrently with the main
review. Source formatting, separate browser contexts and GPU scheduling were not
controlled between the earlier baseline and these windows. Retain the raw data
for inspection, but do not attribute the apparent timing improvement to the AO
change. The same-loaded-scene shadow audit above verifies correctness; performance
causality and sustained 60 fps during bot combat remain unverified.

## Final provenance refresh and reproducible stair probe

A helper formatted files beyond its assigned diagnostic scope, including the
static exporter. Its byte fingerprint therefore changed even though geometry
was unchanged. The main writer refreshed the scene and ran a new local CPU bake
in tools/assets/build/market-neon-static-ao-20261006/cpu, then used the validated
isolated installer. Input SHA is
3b8f3a2b9910be7cad98738dacc1aa522671fc40acd6534dae40c0568c5e8bdb.
The 128-sample bake took 14.869 s and reproduced the exact previous 25,209-byte
texture hash, with zero clipped channels. The first invocation correctly rejected
a nonempty output directory; the successful output used a fresh cpu subdirectory.
No remote GPU job was launched. The final bundle is index-Ct9ACaXv.js, built in
2.38 s, still 8,086.30 kB / gzip 3,042.83 kB. Pipeline tests passed 21/21,
installed static runtime tests 6/6, and exporter tests 3/3.

The main writer created and ran tools/assets/probe-soldier-stair-reach.mjs after
the delegated probe was not delivered. Its JSON receipt in tools/assets/build/
soldier-stair-reach-20261006.json fingerprints the actual GLBs, script and relevant
source. Ten sampled poses and 48 idle foot-bone/tread queries are retained.
Standing chains are approximately 0.7756 m; fixed-hip ankle targets 28 cm lower
overreach by 25.3–25.9 cm and require 25.9–26.6 cm hip lowering. Crouch targets
have more reach. These are geometric reach calculations, not an implemented IK
or boot-contact solution. Foot-bone-to-tread distances are not sole clearance.
The earlier unsaved helper's claimed head-centre clearance is also superseded:
the saved probe distinguishes the actual head bone from the existing tests' eye
proxy, and does not establish full skull containment. No collider, hitbox or
rendered actor root was shifted in this pass. Future stance work must measure
actual boot soles and preserve shot alignment during motion, crouch and slopes.

## Improvement 17: actual boot contact on Market stairs

Added lower-leg terrain placement shared by the local body, practice figures,
sparring partner and online soldiers. It samples visible surfaces, chooses a
reachable nearby tread, gives the unsupported foot first choice and keeps the
boots separated. The two-bone solve rotates joints without translating the hip,
rendered actor root, upper body or gameplay hit volumes. The current deformed
sole is checked after placement, including toe animation and blended calf weights.
Stationary plants are retained and revalidated instead of repeating the broad
tread search during idle breathing. Airborne, prone, sliding, riding, seated and
dead poses keep their existing animation; raised walking swing feet are not planted.

The accepted runtime regression uses both shipped rigs, standing and crouched,
four headings and six actual settled Market stair roots: 96 poses / 192 boots.
Sampled contacts meet the 2.5 cm gap / 1.5 cm penetration limits; ankle separation
exceeds 10 cm. Head and gun position stay within 0.01 mm of the original animation,
normalized weapon orientation stays aligned and segment lengths are unchanged.
All 45 focused tests, types, scoped lint, formatting and production build pass.
The 96-pose asset test has a local 60-second timeout; a full run exceeded the
project's 20-second default before that bounded adjustment. The final bundle is
index-BowDqB-L.js, 8,091.37 kB / gzip 3,044.58 kB, built in 3.38 seconds with the
existing large-chunk warning. Seven preserved main/Claude file hashes still match.

The isolated dev-only foot-contact-review.html compares the same real rig and
Market stair geometry before and after. Standing and crouched screenshots are
saved under gameplay-captures/2026-10-06/market-quality/. This fixture is contact
evidence, not a whole-scene graphics acceptance. Its visible one-soldier update
timings and limitations are retained separately; no whole-game FPS gain is claimed.
The temporary review tab was closed after capture. Branch 5174 remains playable.
Exact source fingerprints and the execution retrospective are in
docs/evals/market-foot-placement-20261006.json.

The read-only baseline helper also delivered a reproducible skinned-vertex probe:
tools/assets/probe-soldier-boot-contact.mjs and its JSON report. Its 48 raw-GLB poses
show both floating and penetrated soles; raw model headings differ from the
runtime's facing offset. Production acceptance therefore uses Soldier.update,
not that diagnostic's coordinate convention. Motion, slopes, combat pacing,
distant facade art and whole-map AAA acceptance still require work. No Modal job,
commit or push was performed in this pass.

## Improvement 18: Palace stone and resolved distant weathering

Palace-classified facade walls reuse the authored column stone PBR maps across LODs,
while window pixels and surrounding blocks keep their original materials. One byte per
vertex marks Palace surfaces. Geometry and draw counts are unchanged. Fine grime now
filters by projected footprint; broad weathering no longer vanishes at 45–70 metres.
An independent visual review prompted a modest warmer facade tint and still identifies
shallow relief and repeated windows as limits. Fixed hall and forecourt screenshots
are saved with the other two improvements in the 2026-10-06 market-quality captures.

All 62 focused facade/material tests, types, scoped lint and build passed. The separate
moving boot probe also passed; its planted-contact maximum gap was approximately 1.2 cm,
but swing-foot toe clipping and continuous stair traversal remain open. A fixed 720p
static game sample confirms the in-app browser's NVIDIA Quadro renderer, but p95 frame
intervals of 65.9 ms fail the proposed 25 ms target. No smooth-60-FPS or performance-gain
claim follows. Main and the seven preserved Claude-file hashes match; no commit, push
or Modal job was performed. Detailed evidence and limitations are in
docs/evals/market-facade-distance-20261006.md and its adjacent JSON ledger.

## Improvements 19–21: distant window stability, swing toe clearance and stone surrounds

Window interiors now compute derivatives before per-window divergence, integrate
mullion/blind coverage at the pixel footprint and avoid undefined parallel room rays.
Raised swing feet receive a vertical correction only when their actual deformed sole
penetrates visible terrain; clean swing feet keep their original position. The fixed
128-frame moving probe verifies both rigs, <=8 mm penetration and upper-body/root
preservation; continuous character-controller stair traversal remains unproven.

Palace near-LOD windows on the bottom two storeys have one stone surround profile.
The initial whole-building and two-profile versions failed cost gates and were revised.
Accepted actual facade triangles rise 8.52% in the hall pose and 7.76% in the forecourt
pose, with unchanged three draws and shadow proxy. Buffers grow by 1,866,816 bytes.
Final geometry tests (42) passed; window/contact checks from the preceding run passed
on unchanged sources. Types, scoped lint and production build passed. No game-wide
FPS improvement or AAA acceptance follows from these measurements.

The final one-profile screenshot was initially pending because supported browser capture
failed; the saved two-profile comparison is labeled provisional. Fresh hall, forecourt
and night captures on 2026-10-07 now show the accepted one-profile geometry. All seven preserved
Claude hashes and main HEAD match. No main edit, commit, push or Modal job. Detailed
checks, rejected costs and limitations are in docs/evals/market-window-stability-20261006.md.

## Improvement 22: remote gunfire direction and audible cover

Online rifle/pistol/coil reports now queue until the current listener camera is ready.
They use the same visible-surface cover query as explosions, with stereo direction,
propagation delay and muffling behind visible walls. The remote queue is capped at 64;
silent coil reports beyond 25 m skip the ray entirely. Sampled and fallback paths share
routing and cleanup. Forty focused audio/physics tests, types, scoped lint, formatting
and production build passed, including the actual Market hall wall/open doorway.

A controlled 20-second stereo WAV renders the actual rifle recording through the old
and new audio paths. Cover flags are supplied manually for the listening comparison;
the physics regression separately proves actual hall cover detection. The primed master
bus render has zero clipped samples, symmetric left/right RMS and quieter covered reports.
WAV and receipt are saved in gameplay-captures/2026-10-07/market-quality/. Listening
acceptance, crowded combat mixes, frame pacing and whole-map AAA quality remain open.
Evidence and execution notes: docs/evals/market-shot-audio-20261007.md and adjacent JSON.

## Improvements 23–25: foot update cost and continuous hall stair support

Rejected sole candidate scans stop when remaining vertices cannot improve their score.
On identical 864-frame controller inputs this preserves every recorded pose/contact
value and reduces support calls 0.429%; it is not a measured FPS improvement. Reusable
sole scratch vectors then preserve both poses and query counts exactly, with independent
candidate outlines to avoid aliasing during resampling.

The hall stair flight had a real 0.8 m gap before the upper landing. Extending the landing
to the existing top tread with a 1 cm overlap closes it while preserving tread spacing.
The new visible-ray and controller regressions fail on the original gap and pass on the
correction. Across 864 tested up/down frames, airborne frames fall from 16 to 0 and
frames with both soles unsupported from 18 to 0; maximum penetration falls from 10.649
to 4.996 mm. Flight animation gates and root/head/weapon alignment are preserved.

Twenty focused tests passed, followed by a passing affected-test rerun after a lint-only
test declaration cleanup. Types, scoped lint, formatting and production build passed.
Three actual-game captures are saved in gameplay-captures/2026-10-07/market-quality/:
market-current-hall-page.png, market-current-forecourt-page.png, market-current-neon-page.png.
They show High / 100% / DRS-off day and night views, including final Palace surrounds.
The branch menu on 5174 is playable and connected. Main HEAD and all seven preserved
Claude hashes match. Wider art and measured combat frame pacing remain open.
Evidence: docs/evals/market-moving-contact-cost-20261007.md and adjacent JSON ledger.

The geometry update also required a local lightmap re-bake: the old layout was being
skipped. The 64-sample bake completed with zero trapped rays; eight lighting tests,
types, lint and the updated build passed. A fresh game reload has no lightmap warnings.
Final captures with restored lighting are market-baked-hall-25.jpg,
market-baked-forecourt-25.jpg and market-baked-neon-25.jpg in the same directory.
The earlier PNG-named captures predate that re-bake.

## Improvements 26–28: foliage detail across distance

Far tree alpha coverage is preserved per baked view, transparent backgrounds are
excluded from generated normal mips, and near leaf textures retain coverage at smaller
sizes. Shipped texture dimensions, geometry and collision behavior are unchanged.
Nine focused tests, types, scoped lint, build and all-three-species asset checks pass.
Three screenshots are market-tree-after28-hall.jpg, market-tree-after28-forecourt.jpg
and market-tree-after28-neon.jpg in the same capture directory.

The visible static hall sample records p95 33.3 ms, versus 49.8 ms earlier at identical
viewport/settings. A single pair does not establish causality or smooth combat; the
25 ms target remains unmet. Flat billboard silhouettes and whole-map AAA acceptance
remain open. Evidence and ledger: docs/evals/market-tree-filtering-20261007.md/json.

## Improvements 29–31: supersampled tree assets and packed canopy shading

Existing tree meshes are rendered at 4× source resolution and reduced into the same
eight-view atlases with covered linear colour and normalized vector averaging.
Packed canopy AO retains independent coverage weights through the normal mip chain
and affects only indirect diffuse light through the existing texture lookup.
The isolated branch uses the six validated atlases; old files remain in a local backup.
Compressed assets grow by 1,000,984 bytes; GPU texture dimensions, geometry, colliders
and per-tree passes are unchanged. This is a fuller distant canopy, not volumetric
foliage or whole-map AAA acceptance.

Eleven runtime tests, three reducer tests, seven validator tests, types, scoped lint,
formatting, production build and shipped asset checks pass. Day/night real-game
screenshots are under gameplay-captures/2026-10-08/market-quality/ as
market-tree-after31-hall.jpg, market-tree-after31-forecourt.jpg and
market-tree-after31-neon.jpg. The latest static p95 remains 107.6 ms, compared with
108.0 ms before; host activity and unequal scene counts prevent causal attribution.
Frame spikes, detailed facades and broad bot/object contact validation remain open.
Main HEAD and all seven Claude hashes match; no cloud job, commit or push occurred.
Evidence: docs/evals/market-tree-bake-20261007.md and adjacent JSON ledger.

## Improvements 32–34: repeated rendering work and coherent window state

The world updates matrices once per frame instead of four times across depth,
world and AO transparency passes. Moving transforms, camera/viewmodel updates and
shadow semantics are preserved. The matched live A/B sample has the same 444 draws,
1,533,372 triangles and 104 shadow draws; matrix CPU median falls from 1.3 to 0.4 ms.
Callback p95 still exceeds 100 ms, so smooth combat and GPU speedup are not established.

Window identity uses its recovered, quantized physical centre instead of each
fragment's coarse world tile. Actual shipped GLSL on NVIDIA float32 splits zero of
12 tested window/orientation groups, versus 12 on the old key. Adjacent 3x2 groups
share restrained occupancy and curtain/blind probabilities. Parallax rooms,
footprint filtering, warm lamps, maps, geometry and collisions remain.

Thirty-six focused tests, types, scoped lint, formatting and final build pass. Three
real-game views are market-after34-hall.jpg, market-after34-forecourt.jpg and
market-after34-neon-hall.jpg in gameplay-captures/2026-10-08/market-quality/.
Visual change is modest: larger facade hierarchy, existing night seam lines,
frame spikes, whole-map art and broad combat/contact acceptance remain open.
Evidence: docs/evals/market-frame-causality-20261008.md/json and
docs/evals/market-window-coherence-20261008.md (GPU/source receipts referenced there).

## Improvement 35: Palace course/frame topology

Detail courses no longer generate opposing coplanar undersides where a raised
frame already owns the border. The actual Market regression reproduces 707
overlapping pairs before the correction and zero afterward, plus 90 to zero in
a synthetic tall Palace. Whole-wall coverage, panes and the negative collision
envelope retain their existing checks; no extra draw, asset or collider is added.

Forty-six focused facade tests, types, formatting and production build pass.
Actual 1280x720 day/night hall captures are market-after35-day-hall.jpg and
market-after35-neon-hall.jpg in the Oct 8 capture directory. Remaining dark
horizontal bands are visible; topology correctness is established, their full
appearance is unresolved. Screen AO, sun shadows, prepass, baked AO, cavity AO
and normal maps individually off do not eliminate the bands. Solid facade
geometry shows no visible holes. Authored joint design is the next diagnostic.
Whole-map AAA, frame spikes, combat/contact and audio acceptance remain open.
Evidence: docs/evals/market-facade-band-investigation-20261008.md/json.

## Improvements 36�37: consistent distant structure and cheaper triangulation

Artificial flush segment ridges are removed; middle and far cells retain the
same structural frame and recessed painted windows. Course end caps preserve
mixed-LOD boundaries without replacing the architecture with flat distant walls.
Across 1,493 Market faces, 7,316 shared intervals close correctly, including
eight intentional crown steps. All 6,284 physical near panes remain.

Boundary-only triangulation retains all collinear boundary vertices and removes
redundant centre fans. The intermediate Low facade budget failure (69,007
triangles) is resolved at 62,721 against the original 65,000 limit. Draw passes,
colliders, maps and lighting effects retain their existing behavior.

Fifty-four focused tests, types, scoped lint, formatting and production build
pass. Matched day/night/forecourt captures and the before/after Palace crop are
market-after37-day-hall.jpg, market-after37-neon-hall.jpg,
market-after37-day-forecourt.jpg and market-facade-before-after37.jpg in the
Oct 8 capture directory. The long seam ridge disappears; authored sills/courses
and cornices remain. This is visible defect correction, not whole-map AAA proof.

The visible 1280�720 NVIDIA night static sample has median 33.2 ms and p95 49.9 ms;
the target remains unmet, and unequal scene counts prevent causal speed attribution.
Main HEAD and seven preserved Claude hashes match. No new cloud job, commit or
push occurred. Art hierarchy, moving/combat frame pacing and broad physics/audio
acceptance remain open. Evidence and ledger:
docs/evals/market-facade-lod-continuity-20261008.md/json.
