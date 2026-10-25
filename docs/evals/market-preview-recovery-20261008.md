# Isolated preview recovery and rejected browser comparison

The preceding accepted goal turn made progress through improvements 32–34, with
source changes and focused verification retained in the frame/window reports.
The interrupted Chrome attempt produced no accepted timing comparison. This turn
revalidates the saved work and restores a playable isolated preview.

Acceptance before further production edits: retain `codex/isolated-finish`, preserve
main and the seven recorded Claude file hashes, make the branch preview reachable,
and accept a browser comparison only when hardware, actual drawing-buffer size,
scene/settings and visibility support comparison. No production source edits were
made during this recovery.

Git reports all applied changes in the isolated worktree at
`C:/Users/kiran/myprojects/warsaw-downtown-codex`, including rendering, assets,
audio and shared physics changes. They remain local, uncommitted changes.
Main HEAD is `cb35f065f7b5b78a2e38a61bc61a321fc5c6244e`; all seven SHA256s in
`tools/_codex-preserved-files.json` match. No commit, push or merge occurred.

The old preview process handle was missing and Chrome reported connection refused.
The first new sandbox launch remained alive but sandbox fetch reported EACCES and
an unsandboxed reachability check timed out. That owned launch was stopped through
its execution handle. Launching the existing isolated-preview script outside the
sandbox restored browser access to port 5174 (game server 2568). The script refuses
occupied ports and was not modified. Live handle at recovery: 67285.

The Chrome diagnostic then loaded the real Market and completed its existing
3-second warmup / 20-second sample. Receipt:
`tools/assets/build/market-chrome-unmatched-20261008.json`.
It reports Intel UHD Graphics, a 696×707 drawing buffer, 563 draws and 2,035,524
triangles. The prior accepted NVIDIA samples used 870×884, 444 draws and 1,533,372
triangles. Thus this is **not** a matched Chrome/IAB experiment and cannot establish
a browser speedup or regression. Its 21 frames / 20 intervals have p95 interval
1013.5 ms, p95 CPU frame 54.3 ms and GPU median 57.14 ms. Zero hidden frames are
reported; that signal alone does not establish browser focus or explain the
near-one-second cadence. No causal explanation is claimed.

The measured Intel renderer changes the next action: re-establish the actual GPU
and drawing-buffer conditions before comparing browsers or optimizing the observed
frame gaps. The earlier NVIDIA >100 ms gaps and whole-map AAA art, combat physics
and audio acceptance remain open. No visual-quality reduction was applied.

The existing IAB branch tab is retained at the normal Market menu. Proof images:
`C:/Users/kiran/myprojects/gameplay-captures/2026-10-08/market-quality/branch-ready-20261008.jpg`
and `chrome-profile-unmatched.jpg` in the same directory. Temporary Chrome viewport
override was reset and the new diagnostic tab was closed. Existing user game tabs
were not closed or reloaded.

Execution ledger: this turn is progress (restored live preview, preserved state,
and obtained evidence rejecting an invalid performance comparison). Production
tests/build from improvements 32–34 are prior evidence, not rerun or relabelled as
new checks. Environment corrections: sandbox preview launch and stale browser
attachment. Two read-only DOM metadata queries encountered unsupported scope;
neither mutated page/game state. Paid cloud jobs: zero. Measured cost, elapsed-time
baseline and agent speedup: unknown. Goal remains active.
