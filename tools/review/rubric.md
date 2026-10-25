# Fresh-context review rubric

Used by both reviewers: the in-app workflow (`.claude/workflows/fresh-review.js`) and the headless
runner (`tools/review/fresh-review.mjs`). Every reviewer starts with **no conversation context**: it
sees only the diff, the repository, and `CLAUDE.md`. It replaces the Codex review as the pre-commit
gate. Codex returns Oct 3 and then reviews everything since the outage.

## Ground rules for every reviewer

- **Read-only.** Never edit, stage, commit, install or run the game. Use read-only commands only:
  `git diff`, `git show`, `git log`, `rg`/Grep, Read. In-app reviewers may run a single targeted
  `pnpm vitest run <file>` when that settles a finding; headless reviewers have only Read, Grep
  and Glob (no shell: even `git diff --output` writes files), with the diff handed over as a file.
- Review **the change**, not the codebase. Pre-existing problems count only when the change makes
  them worse or depends on them.
- Every finding needs a concrete **failure scenario**: inputs or state, then the wrong output, crash,
  exploit, hitch or regression. No scenario, no finding. Style nits are out of scope unless a
  CLAUDE.md rule requires them.
- Cite `file:line` in the new version of the file. Quote at most a few lines.
- Severity:
  - **P1**: breaks gameplay, correctness, security, hosting or data; blocks the commit.
  - **P2**: a real bug or rule violation with limited blast radius; fix before merging.
  - **P3**: minor risk or maintainability issue, worth a note.
- It's fine to find nothing. Say so rather than padding the list.

## Lenses

### correctness

Logic errors, off-by-one, wrong units or axes, sign errors, NaN/Infinity paths, unhandled
rejections, races between async loads, state that is never reset (per life, per match, per
respawn), determinism breaks (the shared sim must be bit-identical on client and server:
`Math.random`, wall-clock time or iteration order leaking into it), and broken invariants the
tests don't cover.

### netcode-security

Server authority: the client sends inputs only, and the server decides hits, health, pickups,
board and scores. Every client→server message has a valibot schema in `shared/src/net/protocol.ts`
and goes through `room.onMessage(type, schema, cb)`. **One input path**: bots and humans only go
`PlayerInput → sanitizeInput → stepPlayer`, never through shortcuts. Also check: lag-compensation
bounds, rate limits, snapshot fields (own-state vs others), trust of client-reported values, path
traversal and header handling in the static server, secrets in the diff, and unsafe
deserialization.

### perf-rendering

The fps rule is realistic **and** 50–60 fps in the browser. Check for:

- shader programs created after `Game.warmUp` (new materials, `onBeforeCompile`, or defines
  toggled at runtime);
- per-frame allocations in hot loops (`new Vector3` and the like, closures, arrays);
- texture or geometry uploads mid-match;
- draw-call growth, overdraw and transparent sorting;
- work that runs on Low when it should only run on Medium+;
- LOD and culling mistakes.

**Concealment must be identical at every quality tier**: foliage or clutter that hides players is
never culled or thinned by a setting.

### tests-gates

Does each behaviour change have a test that would fail without it? Look for:

- tests that assert nothing meaningful, or that mirror the implementation;
- timing-flaky tests;
- skipped gates;
- generated artifacts left stale: lightmap bake (`pnpm bake` after Market geometry changes),
  meshopt-packed models (`pnpm assets:pack`), manifests.

A Python change needs pytest; a Remotion change needs a smoke still.

### conventions-assets

The project rules in `CLAUDE.md`:

- Balance numbers live only in `shared/src/config/tunables.ts`.
- Game rules stay pure in `shared`; rendering never decides outcomes, and presentation never feeds
  back into the sim.
- Explicit `.ts` import extensions; `import type` for types.
- Every third-party asset is logged in `ASSETS.md` with its licence.
- No Call of Duty names, maps, UI or logos; no real brands or signage; no Red Cross emblem.
- Paid generation only with Kiran's OK.
- `CLAUDE.md` Status and Decisions are updated when behaviour or architecture changes.
- Conventional commit scope.

### visual (screenshot mode only)

Concrete, visible rendering defects in the given frames: z-fighting or flicker, shadow acne or
peter-panning, light leaks, exposure, broken normals, texture stretching or seams, viewmodel
clipping or scale, HUD overlapping content, fog or sky mismatches, aliasing, bloom/AO halos,
banding. Judge against the project's bar: CoD Mobile–level realism (not its content). Name the file
and the region of the frame. Don't comment on art that is intentionally placeholder.

## Verification (adversarial)

Every finding is handed to fresh skeptics who try to **refute** it. They re-read the code, trace
the actual call path, check whether a guard elsewhere already handles it, and run a targeted test
if needed.

- **CONFIRMED**: the failure scenario really happens.
- **REFUTED**: it cannot happen (cite the guard).
- **UNCERTAIN**: needs runtime evidence nobody gathered.

When evidence is thin, lean towards REFUTED. The gate blocks only on CONFIRMED P1/P2.
