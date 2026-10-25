# Palace detail — round 3, 2026-10-20

New performance candidate above `333706f`; that commit passed the lead's visual grade but
failed Low's GPU budget: west +2.4 ms, forecourt +2.6 ms, close +1.1 ms, alley −0.4 ms.
This round preserves the approved depth parameters and removes most of their fragment work.
**The ≤ +0.5 ms Intel UHD Low and ≤ +1 ms T2000 High gates require the lead's remeasurement.**

## Changes

- `facadeWeathering.ts`: moves sun/normal transforms, light strength, reveal ratios, projected
  course length and geometric side cavity into the vertex shader. Only face-constant top
  brightness and the broad 180–320 m fade interpolate across the existing geometry. One fragment grid serves window
  classification, tone and the remaining dynamic course band.
- `palaceReliefMask.ts`, `materials.ts`: precompute eight fixed reveal/highlight band evaluations
  into **R/B/A of the existing 512² facade/shell roughness textures**, sampled through the
  existing `texelRoughness`. G remains roughness. Albedo and normal bytes are unchanged.
  This procedural bake runs once at material construction; the existing texel cache retains it.
  The scene AO bake is Medium+ only, so it is neither changed nor newly enabled on Low.
- Low: one sine-free ashlar hash, no broad octave, mineral hue drift, base dirt or sill-weathering bands.
  Window reveals, course shadows, ledge highlights and geometric rib/cornice cavity remain.
  HDR retains its richer tone/weathering and uses the same cheaper relief path.
- Tests: fixed-mask coverage and filtering, packed-channel/PBR preservation, cheap Low shader
  composition and stable material keys. Existing LOD, geometry, bake and warm-up tests remain.

No added textures, texture storage, samplers, texture fetches, draws, geometry, frame-loop work or
program families. The existing shell/paint cache keys advance to `palace-depth-v8`.
The vertex shader adds eight scalar varying components (Low can discard the old world-position
varying). Two coherent building-tag guards keep Palace arithmetic off ordinary OSM facades;
the tag is constant on each primitive. Narrow, pixel-dependent branches are removed from the
Palace tone/relief helpers. Existing Three PBR and HDR weather control flow is unchanged.

## Where the work went

The static audit identifies **relief + light setup as 315 of the 391 scalar operations added
in round 2 (81%)**; tone/weathering added 76. Both variation hashes already existed before
round 2. The new Palace patch had **zero added texture/dependent fetches**; fragment ALU and
control flow were the evident suspects. This is source attribution, not a hardware ablation.

| Low Palace painted-wall fragment | `333706f` | Round 3 |
| -------------------------------- | --------- | ------- |
| Scalar source ALU                | 560       | 152     |
| Stone tone                       | 214       | 52      |
| Relief shade                     | 230       | 47      |
| Sun/normal transforms + strength | 71        | 0       |
| Footprint/grid/window weight     | 23        | 31      |
| Existing facade AO               | 8         | 8       |
| Light-result multiplications     | 14        | 14      |
| Filtered bands                   | 12        | 1       |
| Block hashes                     | 2         | 1       |
| Distance fades                   | 2         | 0       |
| Added texture fetches            | 0         | 0       |
| Added dependent texture fetches  | 0         | 0       |

**73% less scalar fragment work** in this patch. The remaining band changes length with the
sun and stays analytically box-filtered. Static reveal/highlight masks get existing mipmap and
anisotropic texture filtering. No fragment `pow`/`exp` is introduced. Other map, normal,
roughness, shadow and PBR sampling is unchanged; the three base surface samples remain three.
The table is not the total material shader.

Count convention: near, sun-facing painted Palace stone, fine/broad detail resolved; one scalar
arithmetic/min/max/floor/fract/step/root/derivative operation = 1; vectors expand by consumed
components. Clamp = 2, mix = 3, mod = 4, smoothstep = 9, dot3 = 5, normalize3/distance3 = 9,
fwidth = 5/component. Literal arithmetic is retained; no folding, CSE or FMA. Branches are
counted separately. These are **pre-compiler source estimates, not vendor ISA counts or GPU
milliseconds**. Expression-level breakdowns and branch inventories are in
[the ALU audit](palace-detail-20261020-alu.json).

## Verification and remaining limits

147 targeted regression tests pass (124 render/geometry/weather tests, plus 23 mask/material
checks). The architectural-budget test was updated for the new shared-grid arguments and
vertex fade; its rerun passes. Tests run under installed Bun because native Vitest cannot start
without the missing Linux Rolldown binding; the material fixture uses a temporary global-stub
compatibility shim, with no dependency/lockfile changes. TypeScript project build and browser
bundle succeed. Final composed GLSL validation compiles and links **16 programs / 32 stages**
(shell/paint × Low/HDR × plain/baked × environment/no-environment). Dependency audit timed
out after 45 seconds under restricted networking.

Prettier and `git diff --check` pass. The full `pnpm check` reached typed ESLint after a
successful typecheck, then stalled in TypeScript project discovery. Scoped project-service
and explicit-project retries timed out at 120 and 180 seconds respectively; the full check
is not claimed as passing. ESLint with only type-dependent rules disabled passes all seven
changed TypeScript files with zero errors or warnings.

The actual extracted old/new vertex and fragment hooks render in a software EGL flat-wall
proxy, with the actual packed texture. At 20 pixels/metre, Low and HDR retain identical sampled
left/right jamb factors **0.196/0.344**, head **0.160**, and course-shadow cavity/direct factors
**0.720/0.080**. The sampled top highlight is softer (**1.125 vs 1.180**). Low intentionally has
quieter stone and less weathering. Visual-verdict score 94 applies only to this labeled proxy;
it is not a game screenshot, AgX grade or hardware timing. Full game capture is blocked by
`listen EPERM` on the local preview socket.

The lead should repeat Low golden, 1600×900, fixed 100%, three alternating GPU-timer rounds at
**west, forecourt, close `(70, 0.05, 6, 1.57, 0.1)`, and alley**; screenshot those plus
`east_face_close`, `palace_from_stalls`, `tower_wide`, and an unobstructed `tower_top`, on Low
and High. Inspect oblique/distant mip transitions and coarse-LOD distant-fade interpolation.
Check sunny/overcast/rain/dusk/neon and the warmed program-count tour. Expected cost is lower
than round 2 on both tiers; no numeric GPU delta is claimed until those measurements exist.
