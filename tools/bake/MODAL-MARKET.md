# Market GPU baking

The optional Modal runner supports `--mode ground` (default) and `--mode static`.
Static uses the atlas dimensions in the exported scene, including its sparse box
receiver UVs. Both modes stage results under `tools/assets/build`; they do not
install textures into the game.

Export the exact isolated checkout after source edits. The runner verifies source
hashes before and after a job, and verifies uploaded baker hashes remotely. Static
output also needs the exact receiver fingerprint, dimensions and linear RGBA8
encoding. PNG decoding checks for lit receiver pixels and black unused slots.

An explicitly approved positive `--approved-budget-usd` is required before a
remote call. This is an authorization record, **not a hard Modal billing cap**.
Resources are bounded to one L4, four CPU cores, 8 GiB memory, 600 seconds,
128 samples and no retries. Input is limited to 8 MiB. Static decoded texture
allocation is limited to 32 MiB; ground output is limited to 16 MiB.

The static baker supports CPU locally and CUDA remotely. CUDA must enumerate an
actual CUDA device and disables CPU devices; absence of a GPU fails the job.
Returned manifests and receipts must agree on device, elapsed time, scene/input,
source, receiver and output hashes. The existing static installer accepts the
validated CPU or CUDA output and verifies the isolated branch before writing.

Current tests use mocked Modal calls and mocked device enumeration. They verify
the workflow boundary, rejection paths and staging behavior. They do not prove
a cloud GPU job ran, its actual cost, or AAA artistic quality. No remote receipt
has been produced in this pass. Installed reference lighting remains a local CPU
bake until a real cloud job is authorized, completed and validated.
