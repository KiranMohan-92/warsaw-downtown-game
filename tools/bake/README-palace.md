# Palace entrance bake pilot

This is an isolated-branch pilot. It supplies baked fine stone maps and a small RGB entrance
light texture to the browser. The stone maps are procedural heightfield authoring; the ground
illumination is a Cycles bake. It does not stream gameplay, bake camera-dependent reflections,
replace game collision or turn an unfinished scene into AAA art automatically.

## Local preparation

Run from `warsaw-downtown-codex` on `codex/isolated-finish`. Export the exact static map region
and the existing cyan `WARSZAWA 2030` sign with:

```text
pnpm --filter @wd/server exec tsx ../../tools/bake/export-palace.mjs
```

The default output is rooted in this isolated checkout even when pnpm changes the working
directory. Run `courtyard_bake.py` in
headless Blender with `--factory-startup`, passing `--scene`, a fresh `--out`, `--size 256`,
`--samples 32` and `--device cpu`. The checked source supports the same bake in a Modal GPU.

The ground bake contains sign illumination only. Sun, sky, changing wetness and moving actors
remain real time. Cycles bakes white diffuse radiance (irradiance divided by PI), encoded in
linear RGBA8 with a fixed scale of 16. No sRGB or display transform is baked into these pixels.
PNG row zero maps to minimum world Z; runtime upload has `flipY = false`. The runtime adds the
illumination through the actual ground material's diffuse BRDF after sky AO, avoiding a second
occlusion pass on already integrated lighting. Only near-ground upward surfaces in the stated
bounds receive it. Boundary feathering avoids a rectangular seam.

`install_palace.py <staging-output>` validates the dimensions/manifest and refuses to run
outside a linked worktree on the isolated branch. It installs only the pilot texture and its
manifest. Changed map geometry or sign placement disables the runtime texture. Changes to
procedural mesh-generation code require an explicit re-export/rebake; the map hash alone
does not fingerprint that code. The exporter omits detailed external prop/model occluders.

## Optional Modal job — not launched during preparation

`modal_palace.py` defines one L4 worker, four CPU cores, 8 GiB RAM, a 600 second execution
timeout, zero configured retries, one container and a two second idle window. The client
uploads only the scene JSON, at most 8 MiB, and this baker source. The remote bake is limited
to 1024 square pixels and 128 samples; missing CUDA fails rather than silently using CPU.
Results are returned to a new local staging folder, never directly to live game assets.

The optional Modal Python SDK and account authentication are needed only for that cloud run.
The worker image follows [Modal's Blender example](https://modal.com/docs/examples/blender_video)
and pins `bpy==4.5.0`; local validation uses the existing Blender 4.5 installation. Cloud image
building, CUDA behavior and GPU elapsed time remain unverified until an authorized run.

Example after explicit approval of the maximum spend:

```text
modal run tools/bake/modal_palace.py --scene tools/assets/build/palace-courtyard/scene.json --output tools/assets/build/palace-courtyard-cloud --approved-budget-usd <approved-limit>
```

The budget argument is an authorization record, **not a billing enforcement mechanism**.
Execution/resource bounds do not impose a hard dollar cap or cover image-build/platform costs.
Check current pricing and the account's spending controls against the approved limit before
launching. Do not run merely to inspect the definition, and do not repeat failed cloud jobs
without checking the receipt/status. No deployment, public hosting or always-on GPU is needed.

Offline checks use standard-library `unittest` discovery under this folder and the game's
rendering/type checks. The fake Modal API in the tests verifies the local refusal/resource
contracts; it does not establish a working remote GPU job.
