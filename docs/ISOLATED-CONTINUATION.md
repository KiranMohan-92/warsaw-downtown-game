# Isolated continuation

Kiran requested a separate, playable continuation that preserves Claude's solution.

## Boundaries

- Checkout: `C:/Users/kiran/myprojects/warsaw-downtown-codex`.
- Branch: `codex/isolated-finish`.
- Original `main`: `cb35f065f7b5b78a2e38a61bc61a321fc5c6244e`.
- Vehicle drive source: `87f7d5e7955e6a92105f2b89323842cd313c429f`.
- Polish source: `d0194bb3719b0475713a4c8314d1ae55d257fc3c`.
- Vehicle art source: `fb7b2571c53642d48fc392bd65c20d45baa4261d`.
- The original checkout, Claude lane checkouts, their uncommitted files, and their processes are read-only inputs. No merges to main and no publication.
- At Kiran's request, the original preview on ports 5173/2567 was stopped; Claude's session and source files were preserved. This copy uses client port 5174 and game port 2568, bound to localhost.

## Acceptance checks, defined before implementation

1. The original main and Claude branch tips and working files remain unchanged.
2. Saved vehicle drive, polish, and art changes are integrated without dropping main's rain, chat, knife, or jetpack features.
3. Dependencies resolve shared game code within this checkout.
4. Type checking, lint, formatting, unit tests, and asset tests pass for each committed snapshot. The client and server production builds pass.
5. The separate server responds to health requests and this copy opens in the browser. Solo and online menus use its server.
6. Vehicle fixes require reproducing the failure and regression coverage. Full virtual soak, bot measurements, warm-up checks, and real GPU play checks are recorded independently; saved historical results are not counted as new verification.
7. Wreck ray meshes must match visible cover on both server and client while preserving movement hulls; ray agreement is checked using actual Rapier queries.
8. Additional presentation changes require measured Low/High player visibility and Intel GPU performance evidence. Unverified work is explicitly recorded as unfinished.

## Execution record

Initial preservation check: original main had only the pre-existing untracked mannequin exporter and `tools/handoff/`; vehicle drive and polish were clean. Vehicle art had two modified ray test/helper files and an untracked mesh decoder. These are copied as inputs, never edited in place.

Measurements of cost, speedup, and rework are unknown unless captured. No comparison with a sequential baseline is claimed.

GPU diagnosis acceptance: display the browser's existing WebGL renderer name in the optional performance overlay, without changing rendering settings or querying it every frame. Verify type checking, lint/format, and the visible label. Paused/background FPS readings are not active-play performance evidence.

## Warsaw 2030 visual preset

Kiran selected dark sci-fi: neon, holograms and dramatic effects. Implement this as an optional presentation preset while preserving existing weather and gameplay. Acceptance: readable cool night lighting and wet PBR surfaces; restrained cyan/magenta lighting accents and animated holographic signage fitted to existing scenery; a matching legible HUD/menu at narrow desktop widths; bounded, pooled geometry with no added gameplay colliders or network authority changes. Low keeps the visual identity without requiring bloom or new shadow lights. Verify settings/preset tests, scene resource disposal and bounded draw counts, screenshots of the real playable scene, and the full integration gates. Do not claim photorealism or a future-era hardware benchmark from the art direction alone.
