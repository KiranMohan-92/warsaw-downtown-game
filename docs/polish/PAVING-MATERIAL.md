# Paving material pass — 2026-10-20

The correction is local to street-level paving/sidewalk. Sky, sandstone, weather presets,
post grade, contact encoding, flat geometry, decal offsets and baked assets are unchanged.

## Diagnosis

Measured the supplied High/golden 1600×900 PNGs. Coordinates are pixel rectangles
`[left, top, right, bottom)`, excluding the weapon/HUD; values are median display RGB.

| Source                                         | Rectangle                | RGB             |
| ---------------------------------------------- | ------------------------ | --------------- |
| `hi-ground-paving_underfoot.png`, shade        | `[200, 470, 350, 560)`   | 81 / 85 / 111   |
| `hi-ground-paving_underfoot.png`, deeper shade | `[260, 330, 450, 390)`   | 73 / 76 / 102   |
| `hi-ground-forecourt_paving.png`, sun          | `[1390, 590, 1470, 620)` | 128 / 112 / 118 |
| `hi-ground-contact_crates.png`, sun            | `[375, 340, 450, 365)`   | 132 / 114 / 119 |

Before: paving base albedo was sRGB **156 / 155 / 150**, with actual generated whole-tile mean
**152.24 / 151.27 / 146.40** (including joints). The albedo is warm-neutral, not lavender.
Display samples include lighting, AgX and the approved saturation grade; these are not raw
linear irradiance measurements or a before/after rendering comparison.

The code trace implicates the blue indirect fill: golden has no HDRI entry and uses the
procedural blue zenith/hemisphere. Low substitutes a boosted blue hemisphere for the PMREM,
so removing only specular reflection would leave Low's cast. Flats have white vertex colours;
albedo is correctly tagged sRGB. Golden wetness is zero. Paving and sidewalk scans are
deliberately excluded from `TEXTURED_SURFACES`; they remain procedural after loading. There
is no runtime `pavingPolish` hook in this revision (`pavingPolish.test.ts` tests the maps).
Dry roughness was already high; the ground hook also incorrectly capped rough joints at 0.9.

## Changes and cost

- Preserve the slab layout and 512px maps. Use a modest grey-beige palette, stronger slab tone
  variation, soft stains on one slab in six, irregular dark cracks and more fine normal relief.
  Reduce exaggerated joint relief and bright bevels. New paving mean: **157.85 / 153.98 / 143.25**.
- Dry face roughness is 0.78–0.94; joints stay 0.98. Shallow wear follows the existing analytic
  clearance contours beside obstacles, rising from 0.45 to 0.7 m and fading out by the contact
  field's supported 0.85 m radius. It lowers face roughness by at most 0.09, with a 0.72 floor,
  and leaves joints/contact grime matte. This is authored
  wear inferred from clearance, not recorded player footsteps or a route simulation.
- Reduce dry granite's indirect-light chroma by 70% while preserving its luminance and some
  cool shade. Apply to hemi irradiance and PMREM diffuse before indirect lighting/AO; local
  bakes and direct lights retain their colours. Only upward street surfaces participate,
  including beyond the detail fade distance. The correction fades with exposed wetness;
  sheltered dry stone retains it. The primary sky reflection lobe remains unchanged;
  PMREM multiscattering also consumes the corrected irradiance.
- **Zero added draws, textures, samplers, texture fetches, shader variants or per-frame
  allocations.** `ground-v3` replaces `ground-v2` within the shared ground program. Warm-up
  continues to cover its existing tier variants. New work is scalar wear arithmetic and two
  luminance/mix operations. Low still skips normal maps; existing normal detail benefits
  Medium+. Expected GPU cost is small, but **the +0.5 ms limit is not measured in WSL**.

## Lead verification

WSL checks: `tsc -b`, touched-file ESLint, Prettier and `git diff --check` passed. Native
Vitest cannot start because this checkout lacks the Linux Rolldown binding. A temporary
Node assertion bridge using the repo's `tools/render-budget-loader.mjs` executed 72 test
bodies successfully across `pavingPolish`, `groundDetail`, `groundContact`, `materials` and
`renderBudget`; this does not substitute for the Windows Vitest runner or driver compilation.
Independent source review checked the hooks against the installed three.js r186 chunks.

Run the full Windows `pnpm check`, then capture Low/Auto on Intel UHD and High on T2000 at
1600×900. Require 50–60 fps, ≤ +0.5 ms Low GPU A/B, and no program-count growth after warm-up,
including Auto tier transitions and weather changes. No browser was launched in this lane.

| Shot                              | Pose `[x, y, z, yaw, pitch]`  |
| --------------------------------- | ----------------------------- |
| `ground-paving_underfoot`         | `[100, 0.05, 0, 3.14, -0.62]` |
| `ground-forecourt_paving`         | `[64, 0.05, -20, 1.2, -0.2]`  |
| `ground-contact_crates`           | `[118, 0.05, 20, 0.36, -0.4]` |
| `ground-contact_sandbags`         | `[70, 0.05, 12, 1.57, -0.35]` |
| `palace-tower_from_forecourt`     | `[62, 0.05, -8, 1.62, 0.42]`  |
| Extra grazing forecourt candidate | `[70, 0.05, -19.5, 0, -0.08]` |

The supplied `ground-paving_distance` pose `[100, 0.05, -40, 0, -0.08]` is inside a hedge in
its reference PNG. Reposition onto clear paving for the 20–80 m/grazing check; the extra pose
above is a candidate on a clear crossing, not a browser-verified replacement.

Check golden's sun/shade boundary, retained contact bands and ground decals over flats,
grazing reflections, wear continuity, and unchanged palace/sky colour. Also capture sunny,
overcast, rain (exposed and sheltered), dusk and neon. Rain still owns film/puddle roughness;
neon/courtyard/lamp bakes remain after the correction. Remaining limits: ungraded after-render
colour/relief, repeated 6 m/3 m texture layouts, clearance-based wear, and unmeasured GPU cost.
