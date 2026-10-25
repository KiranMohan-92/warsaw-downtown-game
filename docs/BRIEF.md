# Project Kickoff: "Warsaw Downtown" (working title), a browser-based multiplayer FFA shooter

You're the lead engineer on this project, starting from an empty folder. I'm Kiran, the product owner. I'll playtest, make design calls, and handle art direction. You own the architecture, the code, the tooling, and the quality of what ships. Work autonomously within each milestone, and stop at milestone boundaries so I can review and play the build.

Read this whole brief before writing any code. Then start in plan mode: produce a plan for Milestone 0 and Milestone 1, and flag anything in this brief that's contradictory or technically unwise before you build it.

---

## 1. Vision

A tight, realistic-feeling first-person shooter set in a fictional near-future Warsaw, in the city center around the Palace of Culture and Science. Up to 6 players drop into a sandbox-style district for a timed free-for-all. Everyone has the same weapons, so skill, map knowledge, and positioning decide the match. The feel should be grounded and tactical in the spirit of modern military shooters: weighty movement, punchy gunfeel, readable sound.

It runs in the browser, and players join by sharing a room code. There are no installs and no accounts for now.

**Originality constraint (non-negotiable):** this is an original game. Don't use or imitate names, characters, maps, missions, UI layouts, weapon skins, sounds, or logos from Call of Duty or any other commercial game. "Modern military shooter feel" is the reference point for tone and quality only.

**Tone:** the setting is a fictional near-future scenario. No real military units, and no references to the Warsaw Uprising or real historical events. Leave out real shop brands and logos in the environment.

---

## 2. Game design spec

### Mode

- Free-for-all deathmatch with 2–6 players.
- A match lasts 10 minutes, or ends when someone reaches 25 kills. Most kills wins, and fewer deaths breaks ties.
- Every player gets the same loadout: an assault rifle, a sidearm, and one frag grenade per life. There are no pickups, perks, or killstreaks.
- Respawn takes 3 seconds and happens at the spawn point that is safest from living enemies (score by distance and line of sight). Spawn protection lasts 2 seconds, or until the player fires.
- **Radar sweep:** every 50 seconds, the positions of all players flash on everyone's minimap for 2 seconds. This keeps a sandbox FFA from turning into six campers. The interval should be a tunable constant.
- Screens: pre-match lobby with room code and ready-up, in-match HUD, and end-of-match scoreboard.

### Map (about 250 × 250 m playable area)

This is loosely based on the real block around Plac Defilad, bounded by Marszałkowska, Świętokrzyska, Emilii Plater, and Złota. It should be recognizable, but gameplay beats geographic accuracy.

- **The Palace of Culture:** exterior, colonnades, and one enterable side wing. The tower itself isn't enterable.
- **Plac Defilad:** break up its open space with market stalls, parked and wrecked cars, tram shelters, barriers, and a construction site with scaffolding.
- **The Centrum metro underpass:** an underground flanking route with at least 3 entrances.
- **Vertical spots:** 2–3 rooftop or balcony positions, each reachable only by exposed routes.
- **Boundaries:** blocked streets with police barriers, a burned-out bus, and a derailed tram, plus invisible collision walls.
- **Cover rule:** every hiding spot has at least two approach routes, so there are no unflankable camps.
- **Spawn points:** 16 or more, spread across the map.

### Gunfeel essentials

- Hitscan weapons with server-validated hits and a headshot multiplier.
- Recoil pattern, spread bloom, ADS (aim-down-sights) zoom, reload, and hit markers.
- Kill feed, damage direction indicator, and positional footstep and gunshot audio.

---

## 3. Technical direction

These are my preferred defaults. If you believe a different choice is clearly better, propose it with reasoning before adopting it.

- **Language and repo:** TypeScript everywhere, in a pnpm workspace monorepo:
  - `packages/shared`: simulation code, constants, message schemas, math, and movement. The same code runs on client and server.
  - `packages/client`: Vite with three.js and Rapier (WASM) for physics and character collision.
  - `packages/server`: Node with Colyseus. The server is the final authority on game state.
  - `tools/`: asset pipeline scripts, including Blender Python (bpy) and gltf-transform.
- **Netcode:**
  - Server ticks at 30 Hz. Clients send inputs, not positions.
  - Client-side prediction with server reconciliation for the local player.
  - Interpolation for remote players.
  - Server-side lag compensation: rewind hitboxes to the shooter's view time, with a capped rewind window.
  - Basic sanity checks on inputs, such as fire rate and movement speed.
- **Rendering and performance targets:**
  - Steady 60 fps at 1080p on a mid-range laptop with integrated graphics.
  - Fewer than 200 draw calls in typical views.
  - Initial download under 60 MB.
  - Use instancing, LODs, texture atlases, and glTF with Draco/Meshopt and KTX2 textures.
- **Assets:**
  - Greybox first, with primitives generated in code or Blender.
  - Later, a real-map pipeline: OpenStreetMap building footprints via the Overpass API, extruded and cleaned with bpy scripts, then hand-dressed.
  - Characters and animations from Mixamo or CC0 packs such as Quaternius and Kenney.
  - AI-generated textures and props will come from me.
  - Keep an `ASSETS.md` log listing every third-party asset with its source and license. Nothing unlicensed ships.
- **Hosting:** the client as a static site and the server on a small VPS or Fly.io. Everything should also run locally with one command: `pnpm dev`.
- **AI bots (M6):** tactical decisions come from TypeSafe's Jev System One model via its JavaScript SDK, called from the server only. I have API access, and the TypeSafe skill is installed in this Claude Code environment.
  - Use that skill for all Jev work.
  - Follow the skill's instruction to read the live TypeSafe docs (API, JS SDK, primitives, confidence, and the closest cookbook) before writing the integration. Don't rely on memory for SDK details.
  - The API key lives in a gitignored `.env` on the server and never reaches the client.

---

## 4. Milestones and acceptance criteria

Each milestone ends with a working, playable build. Don't start the next milestone until I've signed off.

**M0: Foundation**

- Monorepo scaffolded, with lint, format, typecheck, and a Vitest setup.
- `CLAUDE.md` (see Section 5), `docs/DESIGN.md` (a condensed version of this brief), and `docs/ARCHITECTURE.md`.
- Done when `pnpm dev` launches client and server, and `pnpm check` (typecheck, lint, and tests) passes.

**M1: Single-player greybox FPS**

- First-person controller: walk, sprint, crouch, jump, and mouse look with pointer lock.
- A Rapier character controller in a greybox street with boxes, ramps, and a two-storey structure.
- One rifle with firing, recoil, spread, reload, and a raycast hit on target dummies.
- A basic HUD with crosshair, ammo, and health.
- Done when it feels good to move and shoot, holds 60 fps, and has no clipping through geometry.

**M2: Map blockout**

- A 250 × 250 m greybox of the district per Section 2, generated from OSM footprints plus hand-placed cover.
- Spawn points and a debug overlay showing spawns, sightlines, and cover.
- Done when I can walk the whole map, every hiding spot has two approaches, and the metro underpass connects correctly.

**M3: Multiplayer core**

- Colyseus rooms with room codes and a lobby with ready-up.
- 6-player sync with prediction, reconciliation, and interpolation.
- Server-side hits with lag compensation, plus damage, death, respawn with safe-spawn logic, the match timer, the kill limit, and the scoreboard.
- A headless bot client script that joins 5 bots to a room for load and soak testing.
- Done when 6 clients play a full match at 100 ms simulated latency and hits feel fair.

**M4: Game feel**

- Radar sweep and minimap.
- Kill feed, hit markers, and damage indicators.
- Sidearm and grenade.
- Positional audio using CC0 sounds.
- ADS, and the settings menu with sensitivity, FOV, and volume.

**M5: Art pass and ship**

- Warsaw facades, props, lighting, and post-processing.
- The glTF optimization pipeline.
- Loading screen.
- A deployed build I can share by link.

**M6: Agentic bots powered by Jev**

Bots fill empty slots up to 6 players. They join through the same server-side input path as human players, so they get no special privileges.

Each bot's brain has three layers:

1. **Reflex (code, every server tick):** aiming with a human-like error and reaction-delay model, trigger control, recoil handling, and navmesh movement using `recast-navigation-js` baked from the map.
2. **Tactical (Jev, about every 0.5–1 s, and immediately on key events such as taking damage, hearing gunfire, losing sight of a target, or respawning):** one Jev request per decision, carrying the bot's perceived state as named JSON fields, with independent questions asked together so they run in parallel. Use each primitive for what it's designed for:
   - **Choice** for the goal: engage, flank, hold, retreat, reload, hunt, or investigate.
   - **Choice** for the target, from perceived enemies plus a "none" option.
   - **Choice** for the destination, from 20–50 cover or flank candidates your code computes. Coverage matters, because Jev can't pick a spot you didn't offer.
   - **Score** or **Noul** for risk judgments, such as whether to push now or whether a position is compromised.
3. **Personality (optional, later):** per-bot persona traits injected into state, such as aggressive, patient, or vengeful.

Rules:

- **Perception honesty:** bots only receive what they could perceive (vision cone with line of sight, and hearing radius). Never give them the server's full state.
- **Code owns policy:** known rules and execution stay in code, and Jev supplies judgment only. Keep raw judgments reusable, so changing a threshold or weight doesn't require new inference.
- **Freshness:** tag each request with the state snapshot tick, and discard or re-validate answers that arrive after the situation has materially changed.
- **Uncertainty:** use confidence and probabilities with thresholds tuned on logged playtest data, not copied from demos. When confidence is low, or on a timeout or API failure, fall back to the behavior-tree default so bots never freeze.
- **`DecisionProvider` interface:** implement both `BehaviorTreeProvider` (the baseline, which ships first) and `JevProvider`, switchable per bot and per room.
- **Observability:** log every decision (state, questions, answers, confidence, latency, and outcome). Add a debug overlay above each bot showing its current goal, target, and confidence, and track a cost and latency counter per match.

Done when:

- 1 human plus 5 bots play a full match with no stalls.
- p95 decision latency is logged and bots keep acting through injected API failures.
- In blind playtests, Jev bots are noticeably more tactical than behavior-tree bots.
- Per-match API cost is reported.

---

## 5. How we work together

- **`CLAUDE.md` is your memory.** Keep it short and current. It should cover commands, architecture map, conventions, current milestone status, known issues, and decisions made with the reason for each. Update it at the end of every working session.
- **Plan, then build.** For any non-trivial step, outline the approach first, then implement in small, coherent commits with clear messages.
- **Verify your own work.** Don't tell me something works until you've shown it:
  - Run the typecheck and tests.
  - Write unit tests for shared simulation code: movement, damage, spawn selection, and lag-compensation rewind.
  - For multiplayer, use the headless bot script.
  - For visual or interaction changes, use browser automation (Playwright) to launch the client, take screenshots, and check the console for errors.
- **Keep simulation deterministic and testable.** Game rules live in `packages/shared` as pure functions, not scattered through rendering code.
- **Put tunables in one place.** Keep speeds, damage, recoil, timers, and radar interval in a single config module so I can tweak balance without reading code.
- **When to ask me:** only for decisions that are genuinely mine, such as design, feel, art direction, or anything that costs money. For technical decisions, choose sensibly, note the choice in `CLAUDE.md`, and keep moving.
- **Report at milestone end.** Give me:
  1. What's built.
  2. How to run and test it, step by step.
  3. What to specifically playtest and give feedback on.
  4. Known issues and shortcuts taken.
  5. Your proposed plan for the next milestone.
- **Research:** when you need reference material on Warsaw locations or technical topics, use official docs, primary sources, and OpenStreetMap data. Don't use Wikipedia as a source.
- **Security:** no secrets in the repo, validate all client messages on the server, and never trust client-reported positions or hits.

---

## 6. Start now

1. Enter plan mode and give me your plan for M0 and M1, including any concerns about this brief.
2. After I approve, build M0, then M1, verifying as you go.
3. Stop after M1 and give me the milestone report.
