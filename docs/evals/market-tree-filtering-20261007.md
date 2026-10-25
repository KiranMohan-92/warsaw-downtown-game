# Market tree filtering — 2026-10-07

Previous goal turn: progress. The hall landing geometry, foot-update allocation/query
work, regenerated lightmaps, regressions and three actual-game captures changed
authoritative state. The isolated preview session 91459 is directly confirmed live.

Acceptance before edits (improvements 26–28):

- Preserve each of the eight baked views' alpha coverage independently while each
  frame still occupies at least one texel. Existing far coverage is global; do not
  claim to introduce an absent mip system.
- Generate far normal mips from original colour coverage, excluding transparent
  background vectors, and normalize the covered vector average. Preserve level zero.
- Apply the existing coverage treatment to shared near leaf textures without changing
  glTF UV orientation, alpha cutoff, shadow-map leaf texture or material counts.
- Keep shipped dimensions, species/trunk transforms, geometry, LOD limits, collider and
  concealment behavior. Mip texel counts remain the standard chain, with no extra draw.
- Use unequal-density frames and transparent-normal fixtures, plus existing shipped
  tree/model regressions. Run types, scoped lint and build. Verify real game loading,
  fixed hall/forecourt/night images and a paired frame sample; retain weak/failed evidence.
- No main edit, commit, push or Modal job. Local render work can advance while the
  previously requested Modal spending cap remains unanswered.

The actual-game baseline is tools/assets/build/market-vegetation-baseline-20261007.json:
15.035 seconds / 518 frames, visible throughout, High / 100% / DRS off, sunny hall,
870×884 canvas on NVIDIA Quadro T2000 Max-Q. Median frame interval 33.2 ms, p95 49.8 ms.
End-state GPU median 26.846 ms, 444 draws / 1,533,372 triangles (including shadows/post).
This is a static sample, not combat evidence, and fails the existing 25 ms p95 target.
It cannot be compared directly with the older 1280×720 sample.

A bounded read-only review found that active realistic trees replace procedural crowns;
fallback-only crown tuning would miss the current issue. It also identified the original
non-AA 256 px impostor bake and 45-degree view changes as further limits. This pass fixes
filtering first; it does not eliminate billboard flatness or establish AAA quality.

## Final implementation and evidence

26: `treeTextureMips.ts` retains alpha-test coverage separately for each baked view.
27: far normals now have explicit mips that average decoded vectors using original
colour alpha, exclude transparent backgrounds and normalize each output vector.
28: near leaf textures use coverage mips, retaining glTF flipY=false, the existing
alpha cutoff and the shared leaf map used for shadow depth. Original geometry, LOD
limits, colliders and texture dimensions are unchanged. Far colour anisotropy remains
1 and normal anisotropy retains the existing renderer limit to avoid an unrelated
sampling-budget change.

Nine tests across treeModels.test.ts and treeTextureMips.test.ts pass, including a
fixture where the previous global-coverage approach erases a sparse adjacent view.
Types and scoped lint pass. The production build passes in 4.12 seconds: 263 modules,
index-AwoHRRVc.js 8,096.83 kB / gzip 3,046.48 kB. The existing large-chunk warning remains.
The first build invocation used the wrong root Vite path; the corrected installed
client Vite invocation passes. This was a command-path failure, not a code failure.

`node tools/assets/check_tree_filtering.mjs` checks all three shipped 2048×256 atlases
and their near leaves. Every view keeps at least base alpha coverage down to one
texel per view. Alpha coverage increases relative to the global method in 18 ash,
18 oak and 20 pine view/level pairs; this does not mean exact shape is retained at
one texel. Each colour mip chain remains 2,796,220 bytes. Base colour and normal bytes
are identical; generated encoded normal length error is at most 0.006454.
Receipt: tools/assets/build/market-tree-filtering-assets-20261007.json.

Fresh actual-game loading has no recorded warnings/errors. Three native 870×884
screenshots show the hall-to-Palace, forecourt and night views, saved under
C:/Users/kiran/myprojects/gameplay-captures/2026-10-07/market-quality/:
market-tree-after28-hall.jpg, market-tree-after28-forecourt.jpg,
market-tree-after28-neon.jpg. The visible trees still have flat silhouette limits;
the captures do not establish AAA visual acceptance. The forecourt views primarily
verify the scene and lighting rather than isolating foliage detail.

The second static hall sample is 15.002 seconds / 613 frames, same 870×884 High /
100% / DRS-off sunny settings and NVIDIA renderer, with zero hidden frames. Median
16.7 ms, p95 33.3 ms, p99 33.4 ms; end-state GPU median 19.751 ms. Baseline p95 was
49.8 ms. These are two sequential samples, not a controlled repeated A/B experiment;
do not attribute the difference causally to texture filtering or call it 60 FPS.
Frame time still fails the existing 25 ms p95 target. End-state draws differ (444
before, 446 after), triangles differ (1,533,372 before, 1,556,771 after), while shadows
remain 104 draws / 384,858 triangles and shader programs 231. Runtime totals therefore
do not prove exact draw-count equality even though this patch adds no meshes/materials.
Receipt: tools/assets/build/market-vegetation-after28-20261007.json.

Main HEAD remains cb35f065f7b5b78a2e38a61bc61a321fc5c6244e, and all seven preserved
Claude file hashes match. No commit, push or cloud job. The branch remains playable
at localhost:5174. Execution ledger: adjacent market-tree-filtering-20261007.json.

Retrospective: inspect the active model replacement before changing fallback foliage.
Use unequal-density views; a globally correct alpha percentage can still erase a
particular tree view. Preserve original coverage for normal weights, since rescaled
alpha is a visibility correction. Measure performance separately from visual claims.
Measured cost and a comparable sequential delegation baseline are unavailable;
the bounded read-only vegetation review contributed diagnosis, not a measured speedup.

Remaining: supersampled fixed-budget impostor baking, richer distant silhouette/depth,
grass LOD detail, repeated moving/combat frame pacing, broader ground-contact acceptance,
and whole-map art/audio review. This batch is progress; the broad goal remains open.
