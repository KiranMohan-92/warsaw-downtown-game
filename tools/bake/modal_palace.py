"""Optional single-job Modal bake. Merely importing this module never launches a job.

Prepare/validate scene.json locally first. The cloud worker receives only that bounded scene,
not the game repository, credentials or user data. See README-palace.md before running it.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import time

try:
    import modal
except ImportError as exc:
    raise ImportError("Optional Modal SDK missing; local Blender baking needs no Modal SDK") from exc

SOURCE = Path(__file__).with_name("courtyard_bake.py")
MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
TIMEOUT_SECONDS = 600
GPU = "L4"
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("xorg", "libxkbcommon0")
    .uv_pip_install("bpy==4.5.0")
    .add_local_file(str(SOURCE), "/opt/courtyard_bake.py", copy=True)
)
app = modal.App("warsaw-palace-bake-pilot")


@app.function(
    image=image,
    gpu=GPU,
    cpu=4,
    memory=8192,
    timeout=TIMEOUT_SECONDS,
    max_containers=1,
    retries=0,
    scaledown_window=2,
)
def bake_entrance(scene_bytes: bytes, size: int = 1024, samples: int = 128) -> dict:
    """One bounded bake. GPU absence must fail rather than consuming a slow CPU fallback."""
    import importlib.util

    if not 0 < len(scene_bytes) <= MAX_INPUT_BYTES:
        raise ValueError("Scene exceeds the 8 MiB upload limit")
    if size not in (256, 512, 1024) or not 1 <= samples <= 128:
        raise ValueError("Pilot limited to 1024 pixels and 128 samples")
    spec = importlib.util.spec_from_file_location("courtyard_bake", "/opt/courtyard_bake.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("Baker not present in container")
    baker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baker)
    scene = json.loads(scene_bytes)
    start = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="palace-pilot-") as scratch:
        out = Path(scratch)
        baker.bake(scene, out, size=size, samples=samples, device="cuda")
        files = {name: (out / name).read_bytes() for name in ("courtyard.png", "manifest.json")}
    if sum(map(len, files.values())) > MAX_OUTPUT_BYTES:
        raise ValueError("Bake exceeds the 16 MiB result limit")
    return {
        "files": files,
        "inputSha256": hashlib.sha256(scene_bytes).hexdigest(),
        "elapsedSeconds": time.monotonic() - start,
        "gpu": GPU,
        "timeoutSeconds": TIMEOUT_SECONDS,
    }


@app.local_entrypoint()
def main(scene: str, output: str, approved_budget_usd: float = 0) -> None:
    """Run only after explicit spending authorization; output must be a new staging folder."""
    if approved_budget_usd <= 0:
        raise ValueError("A positive user-approved spending limit is required before a cloud call")
    source = Path(scene).resolve()
    target = Path(output).resolve()
    if target.exists():
        raise ValueError("Use a new staging output folder; do not replace live game assets")
    payload = source.read_bytes()
    if not 0 < len(payload) <= MAX_INPUT_BYTES:
        raise ValueError("Scene exceeds the 8 MiB upload limit")
    result = bake_entrance.remote(payload)
    if result["inputSha256"] != hashlib.sha256(payload).hexdigest():
        raise ValueError("Cloud result does not match the staged scene")
    target.mkdir(parents=True)
    for name in ("courtyard.png", "manifest.json"):
        (target / name).write_bytes(result["files"][name])
    receipt = {key: value for key, value in result.items() if key != "files"}
    receipt["approvedBudgetUsd"] = approved_budget_usd
    receipt["budgetIsEnforcedByModal"] = False
    (target / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))
