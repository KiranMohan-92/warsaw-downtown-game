# Facade LOD continuity acceptance

Prior goal turn: progress. It removed 707 opposed course/frame surface overlaps
from actual Market geometry, verified a 797-pair failing regression and kept the
remaining visible band problem open.

Acceptance before editing:

- Work only on codex/isolated-finish; preserve main/Claude; no commit or push.
- Establish segment ridges as a visible contribution through a matched actual
  game comparison. Do not claim the earlier overlap fix removed all bands.
- Keep the structural wall boundary consistent across near, middle and far LODs
  instead of adding flush ridges solely to mask mixed-depth transitions.
- Preserve full window surrounds and the collision envelope. Check mixed LOD
  borders for gaps, overlapping side faces and abrupt surface-depth changes.
- Keep distant costs bounded: retain cheap painted panes, avoid extra passes and
  measure source geometry and actual rendered triangles rather than assuming.
- Verify day/night real-game views, focused geometry/rendering tests, typecheck,
  scoped lint, formatting and production build on the accepted snapshot.
- Retain all current light, texture and contact effects for final captures.

This pass does not prove whole-map AAA, frame pacing, physics or audio quality.
No new paid Modal job is necessary for a wall-topology correction; later art/bake
work remains in scope under the previously unresolved spending limit.

## Accepted results: improvements 36�37

36 removes the artificial flush segment ridges and retains the structural frame
and recessed painted panels through middle and far distance. Near-only courses
terminate 25 mm before internal vertical segment borders where the neighbouring
frame cannot close them. This prevents a course end appearing as an exposed edge
when the adjoining cell switches detail. It adds only 84 detail quads versus the
uncapped candidate. Physical panes remain near-only; all 6,284 panes remain.

The matched night hall views show the long raised horizontal seam disappearing.
Short window sills, authored courses, cornices and colonnade undersides remain.
This improves an actual visual defect but does not establish AAA facade art.
The coarse shell is more expensive than the former distant flat wall: 37,645
quads versus 14,096. Near quads decrease from 161,363 to 157,301. These source
counts cover the whole Market source, not the visible whole-game frame.

37 replaces subdivided rectangular front centre fans with boundary-only convex
triangles. Selecting the smallest positive ear in local double coordinates
preserves collinear edge vertices without leaving a degenerate remainder.
It removes two triangles and one centre vertex per subdivided front. UVs,
normal direction, cavity values, texture maps, colliders and render passes remain.
Invalid or degenerate input fails explicitly instead of dropping vertices.

Actual full-map facade Low plaza geometry falls from the intermediate candidate's
69,007 triangles to 62,721, within the unchanged 65,000 limit. This is facade cost,
not the entire game. Near/far buffer allocation and three material meshes remain.
An independent helper scan reported zero triangulation/area/count/vertex failures
on 26,760 source polygons; root acceptance uses the focused fixtures, mixed-LOD
T-junction regressions, rotated world winding and actual-map triangle budget.

## Corrections and verification

First-pass acceptance is false. The initial ridge-free candidate left 340 sampled
course-border mismatches; course caps resolved them. The first continuity test
expected 10,000 intervals without deriving that threshold from the actual
segmentation; the current independent union-cuts scan covers 7,316 intervals.
The initial assertion also rejected eight authored Palace crown depth steps.
It now requires both near/coarse profiles to agree on each side and a structural
frame side face with correct facing and full depth coverage to bridge each step.
All eight pass that stronger geometric condition, with zero missing/unclosed
intervals. This corrects the test contract without flattening the architecture.
The initial Low budget failure was corrected by triangulation, without raising
its limit or disabling effects.

Five focused files cover 54 passing tests. The first combined run passed 53;
the revised facadeDetail test file then passed 21, including the added rotated
world winding test and final Low receipt. Source runtime files were unchanged
between those runs. Types, scoped ESLint, Prettier and production build pass.
Build: 264 modules, index-DSgjn1JZ.js. The existing large-bundle warning remains.

Actual game captures at 1280�720, High, 100%, DRS off:

- market-after37-day-hall.jpg
- market-after37-neon-hall.jpg
- market-after37-day-forecourt.jpg
- market-facade-before-after37.jpg (labelled, matched Palace crop)

All are under C:/Users/kiran/myprojects/gameplay-captures/2026-10-08/market-quality/.
Final full scene has screen AO, sun shadows, prepass, baked AO (0.85), cavity AO
and original normal maps enabled. The actual-game static night sample records
NVIDIA Quadro T2000 Max-Q, 451 visible intervals over 15.035 seconds, median
33.2 ms, p95 49.9 ms and p99 66.5 ms. The earlier corresponding baseline has
median 33.3 ms and p95 50.0 ms. Unequal actor/shadow counts and shader warmup
prevent a causal frame-speed claim. The 25 ms p95 target is still unmet.

Receipts: tools/assets/build/market-facade-lod-continuity-20261008.json,
facade-low-budget-20261008.json, facade-lod-before-20261008.json,
facade-lod-candidate-20261008.json and facade-lod-final-20261008.json.
Source hashes and main-preservation evidence are in the adjacent JSON ledger.
Prior status-only turn is classified no progress toward quality; this turn
changes authoritative source and verifies a visible fix and bounded cost.
No commit, push or new paid Modal job occurred. Main HEAD and seven preserved
Claude hashes match. Helper was read-only; root was the sole implementation writer.

## Remaining scope

The facades still need stronger authored architectural hierarchy and material
variation, and the district is not yet AAA. Smooth moving/combat frame pacing,
whole-map contact/physics and audio acceptance remain unproven. Current static
captures and topology tests cannot establish those broader requirements.
No new cloud charge is incurred by this geometry pass; later Modal asset/bake
work remains in scope with the previous unresolved spending limit.
