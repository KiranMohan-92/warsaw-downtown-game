# Entire Market detail pass

## Acceptance before editing

- Work only in `warsaw-downtown-codex`, branch `codex/isolated-finish`. Preserve original main/Claude files and prior branch art. No paid job, publication or commit.
- Cover all visible authored Market stalls, containers including boundary pieces, market hall and metro passages. Preserve existing ground, scan props, trees, wrecks and Palace improvements rather than duplicate them.
- Keep shared map, colliders, cover, stair shafts, container openings, hall doors/windows, truck lanes and alleys unchanged. New substantial dressing must sit against or inside an existing solid; small labels/cables are decorative.
- Maximum 1,500 additional prop triangles per stall, 2,000 per container panel and 35,000 interior trim triangles. Merge by material/spatial chunk, reuse textures and cached variants, add no dynamic lights or shadow casters. A single generated shared label atlas may be up to 512 square pixels.
- Verify whole-Market coverage, rotated/raised pieces, immutable layout, finite indexed normals and bounds, deterministic variation, opening preservation, material/grid/quality compatibility and bounded draw/triangle cost.
- Capture matching actual game views for stalls, containers, hall and metro before/after. Run focused tests, types, lint, formatting and production build; preserve source hashes and review evidence. FPS samples do not prove an ultra-framerate combat target.

## Ownership

Root owns integration, material choices, review controls and final verification. Bounded helpers own only `marketContainerDetail`, `marketStallProps`, and `marketInteriorDetail` plus their tests. No helper edits shared files or starts servers.

## Verified outcome · 2026-10-04

- All 87 authored Market stalls receive deterministic labels, receipts, ties/cables and occasional hanging gauge details. One shared 512×512 generated atlas, no downloaded textures.
- Container panels across the Market and its boundary receive shallow corrugation, rails, roof ribs and fittings. Existing open ends and side openings remain clear. Per-panel geometry remains below 2,000 triangles.
- Hall ground/upper floors and metro wall openings receive metal frames, baseboards, tile bands and ceiling brackets: 708 interior pieces / 8,496 triangles. The detail stays within original solid envelopes plus 12 mm tolerance.
- Integration merges container/interior geometry into 32 m chunks and reuses shared maps. Metre-scaled fitting UVs prevent stretching a whole texture tile across each narrow strip. Interior metal variants sample the existing baked room-lamp volume. No new dynamic lights, collision solids or detail shadow casters.
- Final isolated branch: `codex/isolated-finish`, HEAD `d243fe339e4469a8883587e5a9f792197ae4647a`, uncommitted work preserved. No commit, publication or paid job.
- Final 8-file regression run: **47/47 tests passed**, 15.87 seconds, one concurrent worker. Type build, scoped ESLint, Prettier and Git whitespace checks passed. Production build passed in 2.22 seconds; existing large-bundle warning remains (main bundle 8,056.17 kB).
- Real daylight/night scene review recorded no browser warnings/errors. The captures run offline; network combat was not tested. Shared simulation/map files were not edited by this pass.
- Original main remains at `cb35f065f7b5b78a2e38a61bc61a321fc5c6244e`, with its two preexisting untracked paths. All seven preserved original/Claude files match their recorded SHA256 values.

## Rendering evidence and limits

Evidence directory: `C:/Users/kiran/myprojects/gameplay-captures/2026-10-04/market-district/`.

`comparison.html` contains nine matched daylight/night image pairs covering counters, rows, containers, hall floors and metro. Before is the isolated branch before this district pass, not original main. Camera positions/settings match; moving characters, pickups and HUD notifications can differ. Overview is context only: gravity changed capture height, so it is excluded from matched pairs. `verified-snapshot.json` records ten source/test SHA256 values; `review-statistics.json`, `main-preservation.json` and `browser-errors.json` retain the supporting results.

Assembled dressing triangles: 856,194 → 977,654 (+121,460). Dressing batches: 35 → 91. Sampled close-counter scene draws: 472 → 479; other views can show more of the added batches. Eight-second walking samples at High/100%: before median 35.7 ms, p95 53.4 ms (230 intervals); after median 35.8 ms, p95 53.6 ms (224 intervals). These are displayed compositor intervals, not GPU timings or controlled speedup measurements. Combat, weaker devices and prolonged sessions remain unverified. This broad detail pass does not establish AAA fidelity or ultra frame rate.

## Execution ledger and lessons

Work ran approximately 21:57–22:34 Warsaw time; exact start/finish and monetary cost were not instrumented. Three bounded implementation helpers were used, with root integration/review. No sequential baseline exists, so no speedup claim is made.

First-pass acceptance required corrections: stall objects were initially hidden inside authored counters; visible placement was corrected before integration. One helper edited shared integration despite assigned ownership; root removed the duplicate path and restored a single integration. Initial geometry tests used thousands of individual assertions and exceeded their timeout; aggregation retained coverage without increasing timeouts. A later parallel material test timed out under load; the final full suite passed with one worker and the review game closed. A build command initially used the wrong root-level Vite path; the existing client-local Vite CLI built successfully. Visual review corrected fitting UV scale and a warm trim material that tinted intended neutral metal yellow.

For later passes: validate prop visibility against authored counter height before replication; keep a single integration owner; use metre-scaled UVs on narrow fittings; inspect actual base-map colour before choosing tint; take performance samples without competing test/build work; keep gravity-sensitive overview shots separate from fixed-pose comparisons. Artist-authored varied meshes, higher-quality surfaces and lighting, and combat performance work are still needed to approach the requested AAA standard.
