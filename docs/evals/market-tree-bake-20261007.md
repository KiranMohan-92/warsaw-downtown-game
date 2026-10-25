# Market tree source bake — 2026-10-07

Previous goal turn: progress (26–28 filtering, shipped asset checks and captures).
The full browser Market AAA graphics/physics/audio/Modal objective remains unproven.

Acceptance before implementation:

- Bake the existing shipped GLBs, not regenerated presets. Preserve all source hashes,
  framing, yaw convention, eight 256-pixel views, geometry and collision metrics.
- Render one 1024-pixel view at a time; reduce to the same 2048×256 atlas with
  covered linear RGB averaging and covered decoded, normalized vector averaging.
- A transparent sample contributes neither black colour nor arbitrary normals.
  Check partially covered, empty and opposite-normal synthetic cases first.
- Add candidate view-dependent screen-space AO using the installed N8AO 2.0.1
  orthographic pass. No ground plane or directional-light bake. AO uses actual
  alpha-tested leaf geometry depth, affects only indirect light in any later runtime
  adoption, and is kept separate from base colour in candidate outputs.
- Review individual views and coverage/framing/normal validity for all three species.
  Compare real game day/night and fixed-pose cost before any production adoption.
- Candidate outputs stay separate until validated; no main edits, commits or pushes.
  No paid Modal run without the still-missing spending cap.

Host note: shell/browser reads were interrupted overnight. Both recovered on October 8.
Measured active bake seconds exclude that interruption; elapsed productivity and a
sequential speedup are unknown.

## Branch implementation, October 8 — improvements 29–31

29: Re-bake all eight views of the existing ash, oak and pine meshes at 1024 pixels,
then reduce in linear light with colour-coverage weights to the same 2048×256 atlases.
The bake uses production leaf coverage mips and anisotropy. The 1× reference uses
identical meshes/materials. Silhouette bounds differ by at most one output pixel;
covered pixels increase approximately 14–15% for ash, 4% for oak and 10–11% for pine.
This is a fuller canopy, not evidence of additional geometric depth.

30: Source normal reduction decodes, coverage-weights and normalizes vectors. Packed
normal/AO mip generation retains the same vector weights independently of AO alpha.
Empty texels have neutral occlusion. Shipped/mip encoded normal length error stays
below 0.00664, inside the 0.014 quantization allowance. Each colour or normal mip
chain is still 2,796,220 bytes. Geometry, frame angles, LOD distances and colliders
are unchanged; no new rendering pass or normal texture lookup is introduced.

31: Store bounded, view-dependent canopy AO in the normal atlas alpha and opt in via
frame metadata. The existing normal lookup supplies AO, which multiplies only
indirect diffuse light. Direct sunlight, colour alpha testing and legacy metadata
behavior are preserved. Mean covered AO is about 0.983–0.985; this effect is modest
and is not a physical hemisphere bake. The offline N8AO bake emitted an existing
NVIDIA gradient-in-loop warning; the final real game has no captured warning/error.

All six staged WebPs passed source-hash, dimensions, framing, vector and alpha checks.
Lossless normal/AO encoding round-trips exactly. Original branch assets and manifest
are retained in tools/assets/build/tree-before29/. The installed six atlas files grow
from 755,802 to 1,756,786 compressed bytes (+1,000,984); GPU texture dimensions/storage
are unchanged. Startup transfer/decode cost was not benchmarked.

Validation: 11 focused runtime tests, 3 reducer tests, 7 Python validator tests,
types, scoped lint, formatting and all-species shipped mip checks pass. The initial
parallel Vitest run failed on sandbox temporary-module paths; a one-worker,
non-isolated run passes. A new test initially matched 'indirectDiffuse' with a
substring regex; correcting the assertion to match a field name resolves it. The
first build command used a nonexistent root Vite path; the client package build
passes: 263 modules, 5.47 s, index-CLuXMlH2.js 8,097.33 kB / gzip 3,046.67 kB.
The existing large-chunk warning remains.

Two visible 15-second actual-game hall samples use High / 100% / sunny / DRS off,
870×884 and NVIDIA Quadro T2000 Max-Q. Before: median 35.4 ms, p95 108.0 ms, p99
248.4 ms (368 frames). After: median 18.0 ms, p95 107.6 ms, p99 126.2 ms (479 frames).
Both fail the 25 ms p95 target. This is one sequential pair with concurrent host
activity, not controlled causal performance evidence. End-state draw counts differ
444→450 and triangles 1,533,372→1,583,608; exact rendering workload equivalence is
unproven. Geometry and shader tests support no added per-tree pass, not equal scene
counts or smoother combat. Static GPU medians 16.13→11.53 ms are similarly descriptive.

Three real-game images are saved in
C:/Users/kiran/myprojects/gameplay-captures/2026-10-08/market-quality/:
market-tree-after31-hall.jpg, market-tree-after31-forecourt.jpg and
market-tree-after31-neon.jpg. Day/night rendering is valid; tree flatness, low-detail
facades, frame spikes, moving/combat performance and whole-map AAA acceptance remain
open. Prior stair support fixes are preserved; this batch does not establish that
every bot/object ground-contact case is fixed.

Main HEAD remains cb35f065f7b5b78a2e38a61bc61a321fc5c6244e and all seven preserved
Claude hashes match. No main edits, commits, pushes or cloud jobs. Exact source and
asset hashes, samples and bounded execution ledger are in the adjacent JSON receipt.
Next evaluation should control moving workload and isolate the remaining CPU spikes;
do not spend more GPU time on foliage expecting it to fix those spikes.
