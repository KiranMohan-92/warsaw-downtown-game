# Facade band investigation

Prior turn classification: progress. It restored the isolated preview and rejected
an invalid Intel/NVIDIA comparison rather than accepting a misleading speed claim.

Acceptance before editing production sources:

- Preserve main/Claude; write only the isolated branch worktree; no commit/push.
- Reproduce the existing dark facade bands in a fixed actual-game day/night view.
- Isolate AO, sun shadows, depth prepass and baked cavity light with temporary
  diagnostic controls, restoring the full scene before reporting results.
- Retain architectural depth, rooms, lamps, shadow/contact cues and browser budget.
  Disabling an effect globally is not a solution to this acceptance check.
- Make a production edit only after geometry/shader evidence identifies its cause;
  cover the relevant geometry/rendering behavior with meaningful regression checks.
- Verify the resulting production snapshot with focused tests, types, scoped lint
  and build, plus day/night captures. Narrow evidence does not prove whole-map AAA.

No new paid Modal job is needed for causal isolation. Existing baked assets remain
available for use; broader art/bake work and whole-map combat/audio acceptance stay
in scope. The requested Modal spending limit remains unresolved from prior turns.

## Current result: improvement 35

The previous status-only branch check was no progress toward art quality. This
turn produced causal evidence and a narrow production topology correction.

Fixed actual-game hall captures at High, 100%, DRS off and 1280x720 retain the
bands when screen AO, sun shadows, depth prepass, baked facade AO, vertex cavity
AO or normal maps are disabled individually. The solid-material facade has no
visible holes. These observations rule out those effects as the sole cause;
they do not establish that lighting has no influence. Diagnostic receipts verify
the switches and restoration: tools/assets/build/facade-band-isolation-20261008.json.

A bounded read-only geometry helper identified opposed coplanar course/frame
steps at segment joints. Root reproduced the failure in a regression check:
707 overlapping pairs across the actual Market's 803 monumental faces, plus
90 in a synthetic tall Palace. The helper measured 86.3082 square metres of
shared coplanar area on the Market. Detail relief's upper/lower outside depths
were incorrectly assumed to be the recessed field; sampling the actual adjacent
frame depth prevents emission of those duplicate undersides. The new regression
finds zero overlaps. Existing facade tests retain whole-wall coverage, window
layout and the negative collision envelope. No texture, collider, added draw
pass or cloud job is introduced by the correction.

Actual day/night captures are market-after35-day-hall.jpg and
market-after35-neon-hall.jpg under
C:/Users/kiran/myprojects/gameplay-captures/2026-10-08/market-quality/.
The remaining black bands are still visible in the night comparison. Removing
the topology defect therefore does not establish a visual band fix; the next
investigation is the authored segment-ridge/course design. No whole-map AAA,
smooth combat, audio or broad physics acceptance is claimed.

Validation: 46 tests in facadeRelief, facadeDetail and facadeShaders pass;
typecheck, scoped lint and formatting pass. Production build succeeds with 263 modules
and index-CK2qraEe.js; the existing large-chunk warning remains. Browser warning/
error log query is empty. All seven recorded Claude files still match.

Execution corrections: the first fixture accidentally supplied a map factory,
so its failure covered only the synthetic case; the corrected fixture reproduced
all 797 overlaps. A test guard initially counted only paired border overlaps,
which correctly disappeared after the fix; it now independently counts frame
borders. One verification command used the client directory with root-relative
tool paths and was rerun from the correct directory. First-pass acceptance and
speedup are not claimed; cost and a comparable sequential baseline are unknown.
