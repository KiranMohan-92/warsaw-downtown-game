"""Budget-authorized, bounded Modal ground/static bakes; stage results without installing."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import tempfile
import time

import modal
from market_neon_bake import MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, validate_scene
from market_neon_static_bake import (
    ENCODING as STATIC_ENCODING, MAX_OUTPUT_BYTES as STATIC_OUTPUT_BYTES,
    MAX_TRIANGLES, MAX_VERTICES, validate_static_scene,
)
from install_market_neon import ENCODING as GROUND_ENCODING, validate_png as validate_ground_png
from install_market_neon_static import validate_png as validate_static_png

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parents[1]
GPU = "L4"
TIMEOUT_SECONDS = 600
MAX_MANIFEST_BYTES = 64 * 1024
COMMON_KEYS = ("version", "kind", "sceneHash", "layoutHash", "bounds", "receiverY",
               "occlusionPadding", "emitters", "geometryFingerprint", "lightingFingerprint",
               "sourceFingerprints", "limitations")
BAKER_FILES = ("market_neon_bake.py", "courtyard_bake.py", "market_neon_static_bake.py")
image = (modal.Image.debian_slim(python_version="3.11")
         .env({"PYTHONPATH": "/opt"})
         .apt_install("xorg", "libxkbcommon0")
         .uv_pip_install("bpy==4.5.0"))
for name in (*BAKER_FILES, "install_market_neon.py", "install_market_neon_static.py"):
    image = image.add_local_file(str(ROOT / name), f"/opt/{name}", copy=True)
app = modal.App("warsaw-market-neon-bake")


def validate_request(scene: dict, size: int, samples: int, mode: str) -> tuple[str, int, int, int]:
    if mode not in ("ground", "static"):
        raise ValueError("Cloud mode must be ground or static")
    if type(size) is not int or size not in (512, 1024) or type(samples) is not int or not 1 <= samples <= 128:
        raise ValueError("Cloud bake limited to ground 512/1024 pixels and 1..128 samples")
    if not isinstance(scene, dict):
        raise ValueError("Scene must be a bounded object")
    if mode == "ground":
        validate_scene(scene, size, samples)
        return "market-neon-ground.png", size, size, MAX_OUTPUT_BYTES
    validate_static_scene(scene, samples)
    # Reuse ground's strict emitter/source validation without altering static receiver schema.
    validate_scene(dict(scene, kind="market-neon-ground"), size, samples)
    receiver = scene["receiver"]
    if (len(receiver["positions"]) // 3 > MAX_VERTICES or len(receiver["indices"]) // 3 > MAX_TRIANGLES
            or any(type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 10_000
                   for v in receiver["positions"])):
        raise ValueError("Static receiver geometry exceeds finite work budget")
    if len(receiver["receivers"]) > 4000 or scene["receiverMaterials"] != sorted({r["material"] for r in receiver["receivers"]}):
        raise ValueError("Static receiver material/count contract differs")
    return "market-neon-static.png", scene["atlas"]["width"], scene["atlas"]["height"], STATIC_OUTPUT_BYTES


def validate_sources(scene: dict, mode: str) -> None:
    required = {"tools/bake/export-market-neon.mjs", "tools/bake/market_neon_bake.py", "tools/bake/courtyard_bake.py"}
    if mode == "static":
        required.update(("tools/bake/export-market-neon-static.mjs", "tools/bake/market_neon_static_bake.py",
                         "tools/bake/install_market_neon_static.py"))
    sources = scene["sourceFingerprints"]
    if not required.issubset(sources):
        raise ValueError("Missing exporter/baker source provenance")
    for name, digest in sources.items():
        path = (PROJECT_ROOT / name).resolve()
        if not path.is_relative_to(PROJECT_ROOT.resolve()) or not path.is_file():
            raise ValueError("Source fingerprint points outside isolated checkout")
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError(f"Source changed since export: {name}; re-export before cloud bake")


def _gpu_devices(devices: object) -> bool:
    return isinstance(devices, list) and 0 < len(devices) <= 8 and all(isinstance(d, str) and 0 < len(d) <= 256 for d in devices)


def _finite_duration(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and 0 < value <= TIMEOUT_SECONDS


def validate_result(files: dict, staged: dict, digest: str, size: int, samples: int, mode: str = "ground") -> dict:
    """Validate bytes, matching scene provenance and CUDA evidence before any staging write."""
    filename, width, height, limit = validate_request(staged, size, samples, mode)
    if (not isinstance(files, dict) or set(files) != {filename, "manifest.json"}
            or any(not isinstance(v, bytes) for v in files.values()) or sum(map(len, files.values())) > limit
            or not 0 < len(files["manifest.json"]) <= MAX_MANIFEST_BYTES):
        raise ValueError("Unexpected or oversized cloud result")
    data = files[filename]
    if mode == "static":
        validate_static_png(data, width, height)
    else:
        validate_ground_png(data, size)
    manifest = json.loads(files["manifest.json"])
    if not isinstance(manifest, dict):
        raise ValueError("Cloud manifest must be an object")
    expected = {key: staged[key] for key in COMMON_KEYS}
    expected.update(device="CUDA", inputSha256=digest, width=width, height=height,
                    samples=samples, radianceScale=16, file=filename,
                    encoding=STATIC_ENCODING if mode == "static" else GROUND_ENCODING,
                    textureHash=hashlib.sha256(data).hexdigest())
    if mode == "static":
        expected.update(receiverFingerprint=staged["receiverFingerprint"], receiverMaterials=staged["receiverMaterials"],
                        receiverCount=len(staged["receiver"]["receivers"]))
    if any(manifest.get(k) != v for k, v in expected.items()) or not _gpu_devices(manifest.get("gpuDevices")):
        raise ValueError("Cloud manifest does not establish matching GPU bake provenance")
    metrics = manifest.get("metrics")
    pixels = metrics.get("pixels") if isinstance(metrics, dict) else None
    if (not isinstance(pixels, dict) or any(type(pixels.get(k)) not in (int, float) or not math.isfinite(pixels[k])
            for k in ("min", "max", "mean", "nonzeroChannels", "clippedChannels"))
            or not (0 <= pixels["min"] <= pixels["mean"] <= pixels["max"] <= 16
                    and pixels["nonzeroChannels"] > 0 and pixels["clippedChannels"] == 0)):
        raise ValueError("Invalid, black or clipped cloud pixel metrics")
    if (not _finite_duration(metrics.get("elapsedSeconds")) or metrics.get("pngBytes") != len(data)
            or metrics.get("meshes") != len(staged["meshes"])
            or metrics.get("triangles") != sum(len(m["indices"]) // 3 for m in staged["meshes"])
            or (mode == "static" and metrics.get("receiverTriangles") != len(staged["receiver"]["indices"]) // 3)):
        raise ValueError("Cloud work metrics contradict staged scene or time bound")
    return manifest


@app.function(image=image, gpu=GPU, cpu=4, memory=8192, timeout=TIMEOUT_SECONDS,
              max_containers=1, retries=0, scaledown_window=2)
def bake_landmark(payload: bytes, size: int = 512, samples: int = 128, mode: str = "ground") -> dict:
    if not isinstance(payload, bytes) or not 0 < len(payload) <= MAX_INPUT_BYTES:
        raise ValueError("Scene exceeds 8 MiB input limit")
    scene = json.loads(payload)
    filename, _, _, _ = validate_request(scene, size, samples, mode)
    # Confirm uploaded executable sources are the sources declared by the export.
    for name in BAKER_FILES if mode == "static" else BAKER_FILES[:2]:
        if scene["sourceFingerprints"].get(f"tools/bake/{name}") != hashlib.sha256((Path("/opt") / name).read_bytes()).hexdigest():
            raise ValueError("Modal image baker source differs from exported scene")
    import market_neon_bake as ground_baker
    import market_neon_static_bake as static_baker
    start = time.monotonic()
    digest = hashlib.sha256(payload).hexdigest()
    with tempfile.TemporaryDirectory(prefix="market-neon-") as scratch:
        out = Path(scratch)
        if mode == "static":
            static_baker.bake(scene, out, samples, "cuda", digest)
        else:
            ground_baker.bake(scene, out, size, samples, "cuda", digest)
        files = {name: (out / name).read_bytes() for name in (filename, "manifest.json")}
        manifest = validate_result(files, scene, digest, size, samples, mode)
    elapsed = time.monotonic() - start
    if not _finite_duration(elapsed):
        raise ValueError("Cloud job exceeded bounded duration")
    result = {"files": files, "mode": mode, "inputSha256": digest, "geometryFingerprint": scene["geometryFingerprint"],
              "lightingFingerprint": scene["lightingFingerprint"], "sourceFingerprints": scene["sourceFingerprints"],
              "elapsedSeconds": elapsed, "gpu": GPU, "gpuDevices": manifest["gpuDevices"],
              "timeoutSeconds": TIMEOUT_SECONDS,
              "fileSha256": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    if mode == "static":
        result["receiverFingerprint"] = scene["receiverFingerprint"]
    return result


@app.local_entrypoint()
def main(scene: str, output: str, approved_budget_usd: float = 0, size: int = 512,
         samples: int = 128, mode: str = "ground") -> None:
    if type(approved_budget_usd) not in (int, float) or not math.isfinite(approved_budget_usd) or approved_budget_usd <= 0:
        raise ValueError("Positive finite user-approved spending limit required before cloud call")
    target = Path(output).resolve()
    staging_root = (PROJECT_ROOT / "tools/assets/build").resolve()
    if target.exists() or not target.is_relative_to(staging_root):
        raise ValueError("Use a new staging directory inside tools/assets/build; no overwrite or live installation")
    payload = Path(scene).resolve().read_bytes()
    if not 0 < len(payload) <= MAX_INPUT_BYTES:
        raise ValueError("Scene exceeds 8 MiB input limit")
    staged = json.loads(payload)
    validate_request(staged, size, samples, mode)
    validate_sources(staged, mode)
    result = bake_landmark.remote(payload, size, samples, mode)
    digest = hashlib.sha256(payload).hexdigest()
    expected = {"mode": mode, "inputSha256": digest, "geometryFingerprint": staged["geometryFingerprint"],
                "lightingFingerprint": staged["lightingFingerprint"], "sourceFingerprints": staged["sourceFingerprints"],
                "gpu": GPU, "timeoutSeconds": TIMEOUT_SECONDS}
    if mode == "static":
        expected["receiverFingerprint"] = staged["receiverFingerprint"]
    if not isinstance(result, dict) or any(result.get(k) != v for k, v in expected.items()):
        raise ValueError("Cloud result does not match staged scene or GPU receipt")
    files = result.get("files")
    manifest = validate_result(files, staged, digest, size, samples, mode)
    hashes = result.get("fileSha256")
    if not isinstance(hashes, dict) or hashes != {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}:
        raise ValueError("Cloud output fingerprint mismatch")
    if result.get("gpuDevices") != manifest["gpuDevices"] or not _finite_duration(result.get("elapsedSeconds")):
        raise ValueError("Cloud GPU/timing receipt contradicts manifest")
    validate_sources(staged, mode)  # Reject edits made while the remote job ran.
    target.mkdir(parents=True)  # No exist_ok: concurrent output creation cannot overwrite.
    for name, data in files.items():
        with (target / name).open("xb") as stream:
            stream.write(data)
    receipt = {key: value for key, value in result.items() if key != "files"}
    receipt.update(approvedBudgetUsd=approved_budget_usd, budgetIsEnforcedByModal=False,
                   width=manifest["width"], height=manifest["height"], samples=samples)
    with (target / "receipt.json").open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
