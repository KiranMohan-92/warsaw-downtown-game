# Market window coherence — 2026-10-08

Acceptance before final integration:

- Keep main/Claude state intact and modify only the isolated worktree.
- Anchor each room's stochastic identity to its window centre, so a pane crossing
  a coarse world-coordinate boundary keeps one room rather than two random states.
  Check metre UVs, rotated facades and floating-point edge cases.
- Give small groups of adjacent windows shared style probabilities with individual
  variation; retain restrained daylight interiors and warm lamps at night.
- Preserve real parallax rooms, furniture, footprint-filtered mullions/folds/blinds,
  the NVIDIA degenerate-derivative guard, and both near and painted LOD paths.
- No new textures, geometry, collision changes, draws, cloud jobs or quality reduction.
- Verify shader-hook composition and real game compilation, then inspect fixed hall,
  forecourt and neon screenshots. Do not call shader style variation AAA acceptance.

The existing facade already has relief, stone maps, room parallax and curtains.
Increasing distant LOD limits would not address the hall view: its visible Palace
front is already at near/mid LOD. This pass addresses room identity/style only;
larger architectural hierarchy remains a separate art task.

## Integrated result

The physical window centre is recovered from metre UVs and the guarded derivative
tangent basis. Only the random-state key is snapped to 1/64 m before coarse tile
hashing; parallax positions and geometry are not quantized. Three-bay x two-storey
groups bias lamp occupancy (11–25%) and curtain/blind probabilities, retaining local
variation. This is restrained style coherence, not an authored office layout.

The GPU regression uses the actual compiled material's centre GLSL excerpt. Sixty
WebGL float32 samples cover 12 synthetic metre-UV planes at positive/negative 20/40 m
boundaries, near-boundary centres and four wall orientations. The old fragment key
splits all 12 groups; the new key splits zero. Tangent frames are supplied in this
test; real facade derivative reconstruction is checked visually, not exhaustively
proven. Receipt: tools/assets/build/market-window-seed-gpu-20261008.json.

Material composition/idempotency preserves prior hooks, stone/weathering AO,
emissive rooms and texture/lightmap identities. Thirty-six post/depth/shadow/window/
facade/stone tests pass (six files, 3.74 s); scoped lint, formatting, typecheck and
final build pass. Build: 263 modules, 7.38 s, index-CnxV6yYv.js. Existing large-chunk
warning remains.

A source backup was picked up by tooling typecheck. Renaming the preserved bytes
to tools/assets/build/window-before-34/windowInterior.ts.txt fixes inclusion without
changing compiler rules. SHA256 remains
FADEF5366B5E9E64DB5DD76E0CDE7BAA034ECB178ACA995AAD3941ADFA2722D0.
Future source backups should use a non-compilable extension.

Actual High / 100% / DRS-off 870x884 captures in the Oct 8 capture directory:
market-after34-hall.jpg, market-after34-forecourt.jpg, market-after34-neon.jpg
(forecourt) and market-after34-neon-hall.jpg (matching the older hall night pose).
Rooms stay dark in daylight and retain warm lamps at night; no black-frame shader
failure is observed. Visual change is modest. Larger architecture and existing dark
night seam lines remain open; the seam lines also appear in the pre-change after31
night capture. This pass does not establish whole-map AAA quality.

Execution: one bounded window writer; root owns performance and final integration.
Root took over after the initial shader-only test was insufficient, adding GPU
numerical evidence and composition coverage. These were acceptance corrections;
first-pass acceptance is not claimed. Cost and comparable sequential elapsed-time
baseline are unknown. No agent-count speedup is inferred. No paid job, commit or push.
