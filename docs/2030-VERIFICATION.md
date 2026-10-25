# Warsaw 2030 continuation

Local continuation on `codex/isolated-finish`, October 3–4, 2026. The selected direction is dark science fiction inspired by dramatic architectural lighting. This is a first visual pass, not evidence of AAA photorealism or superiority to Control Resonant.

## Delivered presentation

Select **Graphics & weather → Warsaw 2030 — neon night** at `http://127.0.0.1:5174/`. Cool procedural night lighting, wet surfaces and rain use the existing renderer. Four mounted holographic signs, bounded hardware strips, feathered projection beams and ground glow share a small scene layer. The neon HUD/menu remains optional. Existing weather defaults are preserved. No added shadow lights, gameplay colliders or paid cloud resources are required.

The optional performance overlay now identifies the actual WebGL GPU. Menu rendering is capped at 30 frames per second while networking continues; active play retains its existing frame loop. Adaptive quality remains available. The actual captured game scene is in `tools/_codex-neon-preview.png`; this is rendered gameplay rather than a concept image.

## Integration and evidence

- Saved vehicle drive, art and polish work is integrated locally. Tank/helicopter combat queries hit visible triangle meshes; movement retains tuned hulls. Movement/overlap queries exclude ray-only scans. Vehicle-occupied props cannot settle into static collision around the vehicle.
- Original main remains `cb35f065f7b5b78a2e38a61bc61a321fc5c6244e`. Seven preserved original files match their saved SHA-256 hashes. The original checkout still has only its pre-existing untracked mannequin exporter and handoff directory. No remote publication or merge to main occurred.
- Lighting bake: 410.7 seconds; layout `1b782bd5e0309c`; zero trapped rays. Only this checkout's lighting outputs were changed.
- Asset suite: **89 passed**, including real Rapier wreck queries and decoded mesh agreement (`tools/_codex-final-assets.log`).
- Initial complete suite: **1581 passed, 3 failed**. Two helicopter walkability regressions exposed ray-only scans entering character overlap checks; one respawn test exceeded its 20-second limit while other checks were running.
- After correcting movement query membership, all six affected files passed: **64 tests**, 30.03 seconds (`tools/_codex-collision-recheck.log`). The respawn test passed at its original timeout.
- Type checks, lint and formatting passed after the corrections. Client and server production builds passed before the final movement correction; final rebuilds are recorded below when complete.
- Full virtual match before the movement query correction: **PASS**, six clients, 600 simulated seconds, 150 ms RTT, 113.1 seconds measured; zero driver/flight mispredictions and zero errors/disconnects (`tools/_codex-final-soak.json`). Final-snapshot rerun is recorded below when complete.
- Bounded bot smoke measurement: two duels per difficulty/range/start and one 30-second vehicle-enabled FFA per difficulty passed (`tools/_codex-final-bots.json`). This small sample is not a balance calibration.

## Limits and execution lessons

The Codex browser reports Intel UHD graphics. Captured/background/menu FPS is not a controlled active-play benchmark. Low/High player visibility across a full scene tour and sustained GPU combat performance remain unverified. Architectural detail and asset fidelity still fall short of the requested AAA reference; neon styling alone does not establish realism.

Use a single owner for integration, index changes and preview lifecycle. A helper committed shared work earlier than the intended final gate; final checks therefore cover the integrated source explicitly. The first full suite was not accepted. The failures were corrected, rather than recorded as a passing run. Avoid running numerical asset checks alongside latency-sensitive tests. Cost and comparable sequential speedup are unknown.

## Final snapshot checks

The integrated gameplay snapshot passed **186 files / 1,584 tests** in 727.64 seconds (`tools/_codex-final-tests-serial.log`). The corrected full virtual match passed with six clients, 600 simulated seconds and 150 ms RTT in **79.0 seconds**; zero driver/flight mispredictions, errors or disconnects (`tools/_codex-final-soak.log` and `.json`). This is a simulation check, not a browser GPU benchmark.

The server production rebuild passed after the movement-query correction. The subsequent architectural rendering changes and their final client build/GPU checks are tracked in `docs/ARCHITECTURE-PASS.md`.
