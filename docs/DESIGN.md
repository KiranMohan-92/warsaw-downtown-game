# Design (condensed brief)

Full brief: [`BRIEF.md`](BRIEF.md).

**Warsaw Downtown** (working title): a browser-based FFA shooter in a fictional near-future Warsaw, around the Palace of Culture and Science. Grounded, tactical feel: weighty movement, punchy guns, readable sound. Players join by room code. No installs, no accounts.

## Quality bar (Kiran, 2026-09-26)

**Call of Duty: Mobile (2026)–level gameplay and graphics, in the browser.** We match its _quality_, never its content (the non-negotiables below still apply). The way there is CODM's own mobile playbook, which maps directly onto WebGL2 on integrated GPUs:

- **Graphics:** baked lighting (lightmaps + light probes) carries the look, instead of costly real-time AO/shadows; photo-scanned PBR materials in GPU-compressed KTX2/Basis; compressed meshes (Draco/meshopt), instancing and LODs; small, dense, hand-dressed maps; strong colour grading and bloom. Dynamic shadows only where they matter (players, the sun on the near field).
- **Gameplay:** fast and fluid — slide, tactical sprint, mantle/vault (done), snappy weapon animations and switches, strong hit feedback, a well-paced time-to-kill, and scorestreak-style call-ins (our radar/drone uplinks).
- **Smoothness is measured, not guessed:** `tools/motion-probe.mjs` (frame-time p99, max, hitch count) on the reference laptop.

## Non-negotiables

- Original game. No names, maps, UI layouts, sounds, logos, or skins from Call of Duty or any commercial game.
- Fictional scenario: no real military units, no Warsaw Uprising or real historical events, no real shop brands or logos.

## Mode

- FFA deathmatch, 2–6 players. Ends at 10 min or 25 kills. Most kills wins; fewer deaths breaks ties; still tied → shared win.
- Same loadout for all: assault rifle, sidearm, 1 frag per life. No pickups, perks, or killstreaks.
- Respawn after 3 s at the safest spawn (distance + line of sight to living enemies). Spawn protection lasts 2 s or until firing.
- Radar sweep every 50 s (tunable): all positions flash on the minimap for 2 s.
- Screens: lobby (room code, ready-up), in-match HUD, end scoreboard.

## Map (full real block, ≈480 × 690 m playable)

The Plac Defilad block (Marszałkowska / Świętokrzyska / Emilii Plater / Aleje Jerozolimskie). Recognizable, but gameplay beats accuracy.

- **Correction (2026-09-26):** measured from OSM, the block's southern street is Aleje Jerozolimskie, not Złota — Złota is a pedestrian line through the block's middle (the Palace straddles it). The earlier "370 × 470 m" figure was wrong. The real block is ≈425 × 645 m between street centrelines; playable ≈484 × 687 m including the four streets and their far pavements. The Złota line is the north/south section cut.

- Palace exterior, colonnades, one enterable side wing (tower not enterable).
- Plac Defilad broken up: market stalls, parked and wrecked cars, tram shelters, barriers, construction site with scaffolding.
- Centrum metro underpass: flank route with ≥3 entrances.
- 2–3 vertical positions, each reachable only by exposed routes.
- Boundaries: police barriers, burned-out bus, derailed tram, invisible walls.
- Every hiding spot has ≥2 approach routes. ≥16 spawn points.
- **Gameplay customisation on top of the real layout (Kiran, 2026-09-25):** real Warsaw is the base, but add features that make fights interesting:
  - twisting routes (alleys, cut-throughs, switchbacks), no long empty sightlines;
  - hiding spots both inside and outside buildings (enterable ground floors, stairwells, courtyards);
  - underground routes beyond the metro underpass (service tunnels, basements, parking level);
  - tall trees, hedges and planters for concealment;
  - empty shipping containers (some enterable), construction materials, pipe stacks, site cabins and scaffolding.
  - **Soft concealment (Kiran):** trees, bushes and tall grass are where players and bots hide. Bushes (1.3–2.1 m) hide a standing player, tall grass (1–1.3 m) a crouched one; both are walk-through and bullet-through but block sight — for bots too (shared `FoliageIndex`). Hedges are solid.
  - Constraints still apply: every hiding spot has ≥2 approaches. **Concealment is identical at every graphics quality** (foliage and clutter that hide players are never culled or thinned by settings), so Low can't see through what hides players on High.
- **Map scale (Kiran, 2026-09-26): the full real block at 1:1** — ≈370 × 470 m between Marszałkowska, Świętokrzyska, Emilii Plater and Złota, including the whole Palace of Culture (≈255 × 300 m footprint) and its wings. Supersedes the brief's ~250 × 250 m (the Palace alone is larger than that). Implications: more spawns (≥24), the radar sweep and bots matter more for encounter rate, and rendering needs culling/LOD/instancing from the start to hold the performance budget.
- **Map size is a host match setting (Kiran, 2026-09-26): three options.** _Full block_, or one of **two smaller sections of it** (roughly halves, cut so each section still includes part of the Palace and its own underground route). Each section is a playable map in its own right: boundaries (barriers, wrecks, invisible walls) close the cut edge, and each section has its own spawns (≥12). The geometry is shared, so a section is the full map plus a boundary set and a spawn set, not a separate build. The exact cut lines go in the M2 plan for sign-off. In M3 this becomes a lobby setting next to weather and match mode.

## Tight play (Kiran, 2026-09-26: "too open, we lose each other, don't want to run around")

- **Market (close quarters) is the default map size** (~132 × 126 m, 10 spawns): the Palace forecourt + Plac Defilad market. The Palace facade and wings are the west/north/south walls; a container wall closes the east. Brick-pattern 12 m market blocks with 2.5–3 m alleys (no lane longer than one block), ~40% of alley crossings blocked, a two-storey market hall you can run through, a metro passage with 4 entrances, a crashed helicopter (walk-through cabin) and a knocked-out tank (climbable), climbable container stacks, bush clumps. Cover within **4 m** of any spot.
- **Everywhere else on the block:** a deterministic cover-fill pass keeps every street spot within **6 m** of cover (cars, crate piles, sandbags, containers, barriers, food trucks, occasional tank/helicopter wrecks), never in front of doors, passages or stairs.
- **Climb and vault (shared sim):** jump at anything up to 2.3 m with room on top to pull yourself up (up to 2.7 m above the ground with a jump); sprint + jump over anything up to 1.25 m with ground behind it. Deterministic probes + a fixed path checked for collisions; hands are busy while climbing.
- **Radar uplinks (match option: uplinks / off):** fixed contested points (Market: hall upstairs, metro ticket hall; full block: 8). Walking onto one stores **one radar charge** — it reveals nobody. Press **T** (rebindable) to call it in: everyone shows on your radar for 10 s. Uplinks recharge in 40 s; a player already holding a charge walks past without taking it. Outside a called-in radar, your radar only ever shows you, the map edge and the uplinks (Kiran: nobody visible unless you call it). Replaces the brief's automatic 50 s sweep.

## Modern tactical kit (Kiran picked, 2026-09-26)

Fictional, non-graphic, drawn from 2025–26 battlefield trends (small drones and the counters to them). Extends the brief's "no pickups/killstreaks" rule with Kiran's approval.

- **Recon drone (B, from drone uplinks):** fly for 15 s (WASD, Space up, Ctrl down, mouse look) while your body stands exposed; anyone the drone camera sees in the clear (not through walls or smoke, ≤ 60 m, 70° cone; bushes and grass hide you from a low drone, but **from overhead the drone sees into foliage — it is the counter to bush campers**, Kiran) shows on _your_ radar for 6 s and gets a bracket on screen. Audible buzz. B again returns early.
- **Drone jammer (J, 1 per life):** 25 m pulse — knocks down other players' drones and jams their radars (static) for 8 s.
- **Thermal-blocking smoke (H, 1 per life):** blooms to a ~6 m cloud for ~14 s; blocks sight for players, drone cameras and bots alike (shared `smokeVisibility`), identical at every graphics quality.
- Radar reveals nobody by default: only a called-in radar charge (T), your drone's spots, or nothing — and a jammer beats both.

## Gunfeel

Hitscan, server-validated, headshot multiplier. Recoil pattern, bloom, ADS, reload, hit markers. Kill feed, damage direction indicator, positional footsteps and gunshots.

## AI bots (M6)

Bots fill empty slots up to 6. Tactical decisions come from TypeSafe's Jev System One model (JS SDK), **server-side only**; the API key lives in a gitignored server `.env`.

- **Same input path as humans:** bots submit `PlayerInput` through the same server-side path and the same `shared` sim. No special privileges.
- **Three layers:** reflex in code every tick (aim error and reaction model, recoil, navmesh via `recast-navigation-js`); tactical Jev decisions every ~0.5–1 s and on key events (Choice for goal / target / destination from 20–50 code-computed candidates, Score or Noul for risk); optional personas later.
- **Rules:** perception honesty (vision cone + LOS, hearing radius; never full server state). Code owns policy, Jev supplies judgment. Answers are tagged with the snapshot tick and discarded if stale. Confidence thresholds are tuned on logged data. Fall back to a behavior tree on low confidence, timeout, or API failure.
- **Interfaces:** `DecisionProvider` implemented by `BehaviorTreeProvider` (ships first) and `JevProvider`, switchable per bot and per room.
- **Observability:** every decision logged (state, questions, answers, confidence, latency, outcome), a per-bot debug overlay, and per-match cost and latency counters.
- **Done when:** 1 human + 5 bots play a full match with no stalls; p95 latency is logged; bots survive injected API failures; Jev bots are noticeably more tactical in blind tests; per-match cost is reported.
- Use the installed TypeSafe skill and read the live docs before integrating. Nothing TypeSafe-related is installed before M6.

## Targets

60 fps at 1080p on an integrated-GPU laptop; <200 draw calls; <60 MB initial download.

## Milestones

M0 foundation · M1 single-player greybox FPS · M2 map blockout · M3 multiplayer core · M4 game feel · M5 art pass + ship · M6 agentic bots (Jev). Each ends playable; Kiran signs off before the next starts.
