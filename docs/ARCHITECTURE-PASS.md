# Architectural fidelity pass — October 4, 2026

The user rejected the first neon pass as dated. This pass addresses the visible building surfaces and depth on the isolated branch. Main and Claude's checkout remain preserved.

## Acceptance before editing

- At the market spawn, Low retains recessed windows and facade steps at ordinary street viewing distances, with three merged facade draws and the existing flat shadow proxy.
- Stone has real-scale joints, surface grain and bounded roughness variation rather than uniform beige. Recesses retain contact depth even without screen-space AO. Window positions and collision silhouettes remain unchanged.
- Compare actual rendered gameplay at the same spawn, weather and quality; verify shaders on the browser's actual GPU. A concept image is not evidence.
- Existing facade geometry, LOD seam, shader composition, material and neon lifecycle tests pass. Typecheck, lint and affected formatting pass, and client/server production builds pass.
- The integrated gameplay baseline already passed 186 files / 1,584 tests in 727.64 seconds. Rendering-only changes receive focused regression checks. Repeat the full virtual match after the final movement-query correction, sequentially with other time-sensitive checks.

## Boundaries

No new dependencies, paid compute, new gameplay colliders, main merge or remote publication. Do not force Ultra onto the integrated GPU. Sustained active-play FPS and AAA realism remain claims requiring separate evidence.

## Evidence

- Low facade relief now extends to 48 m (mid detail 96 m); Medium extends to 68/150 m. This keeps recessed windows at ordinary street distances. The existing three merged facade draws and flat shadow proxy remain.
- Facade vertex cavity visibility modulates indirect lighting without another texture fetch or render pass. Stone normals remain enabled selectively on Low, and glass retains explicit environment reflections without enabling them on every wall. Night room lighting changes existing uniforms.
- Procedural sandstone has darker joints, chipped edges, varied grain and roughness; no new downloaded textures or dependencies.
- Rendering regression checks: **six files / 57 tests passed**, 16.83 seconds (`tools/_codex-architecture-tests.log`). Column geometry receives a separate final check once integrated.
- The old plaza test expected no near detail on Medium; that expectation contradicted the requested visible depth and was revised to expect near detail. The old Low triangle test counted the entire map without camera culling and failed at 84,433 triangles. The revised test retains the **65,000 visible-triangle limit**, using the actual 70-degree plaza camera frustum. The facade recheck passed all 17 tests; this is a geometry budget, not measured FPS.
- Final gameplay-query simulation: **PASS**, six clients, 600 simulated seconds, 150 ms RTT, 79.0 seconds elapsed, zero driver/flight mispredictions and errors/disconnects. Source: `tools/_codex-final-soak.log` / `.json`. Server production build passed after that correction.
- Original main and seven preserved original file hashes were checked unchanged. No remote publication.
- Ownership checked before the local checkpoint: authenticated GitHub login and repository owner are both `KiranMohan-92` (ID 184304541); exact repository search with `fork:false` returns this repository. Visibility remains private. No remote changes were requested or made.

- Palace entrance columns replace eight plain visual boxes with a single merged stone mesh, stepped bases/capitals and exposed 12 cm recessed flutes. The original map collision boxes remain. The first helper implementation buried grooves behind panels; review rejected it. Raycast and triangle-winding tests verify the corrected surfaces are visible. Column/map checks: **two files / 23 tests passed**, 19.46 seconds (`tools/_codex-columns-final-tests.log`).
- Final type checks and formatting passed. Scoped lint initially found unsafe geometry typing in the new column test; root corrected that cast and its lint recheck passed (`tools/_codex-columns-lint-recheck.log`). Other affected files passed the original scoped lint run.
- Client production build passed: 240 modules, 2.20 seconds (`tools/_codex-architecture-client-build.log`). Server production build passed after the movement fix. `/health` on this isolated game server returned `{"ok":true}`.
- Actual same-spawn/night captures at 1280×720: `tools/_codex-architecture-low.png` and `tools/_codex-architecture-high.png`. Low uses adaptive resolution at **60%**; High was temporarily selected at **100%** with dynamic resolution disabled. Camera/position was fixed at 99.61 / 0.02 / -0.08. Night wetness and lighting are the same; animated rain is not frame-synchronized.
- The F3 overlay identifies **Intel UHD / ANGLE D3D11**. Static observations: **56 fps**, 17.81 ms average / 18.30 ms p99, Low at 60%; **25 fps**, 39.99 ms average / 54.10 ms p99, High at 100%. Saved overlays: `tools/_codex-architecture-low-perf.png` / `tools/_codex-architecture-high-perf.png`. These are short standing-still samples, not a sustained combat benchmark or a claim of ultra frame rate.
- The final Low and High sessions completed graphics warm-up without browser errors/warnings. Earlier repeated development reloads caused a WebGL context loss; that failed session is excluded. The captures show clearer architectural depth at High but also document remaining low-fidelity scenery. No AAA superiority claim is supported.

Full scene-tour player visibility, sustained active-play performance, and a controlled old-source versus new-source comparison remain unverified. The original neon screenshot is historical only. The current Low/High comparison establishes tier-dependent clarity, not a measured speedup from this patch. Adaptive graphics settings are restored for the user-facing preview.

## Execution lessons

Keep shared integration files under one writer. Two helpers crossed their file boundaries briefly; the facade edit was reverted by its author and the small map integration was reviewed by root. Review caught hidden, ineffective column flutes before acceptance, requiring a geometry correction. Counts of cost and a comparable sequential baseline are unknown; no speedup is inferred.
