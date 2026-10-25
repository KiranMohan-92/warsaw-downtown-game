"""Validate a staged landmark bake against its exact scene and install allowlisted isolated assets."""
from __future__ import annotations

import argparse
import binascii
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import zlib

from market_neon_bake import MAX_INPUT_BYTES, validate_scene

ROOT = Path(__file__).resolve().parents[2]
ENCODING = "linear RGBA8 white Lambert diffuse radiance E/PI; row zero minimum world Z; flipY false"
PNG_FILE = "market-neon-ground.png"


def validate_png(data: bytes, size: int) -> None:
    if not 0 < len(data) <= 8 * 1024 * 1024 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Invalid or oversized RGBA8 PNG")
    position = 8
    compressed = bytearray()
    header = end = False
    while position < len(data):
        if position + 12 > len(data):
            raise ValueError("Truncated PNG chunk")
        length = struct.unpack(">I", data[position:position + 4])[0]
        kind = data[position + 4:position + 8]
        stop = position + 12 + length
        if stop > len(data):
            raise ValueError("Truncated PNG payload")
        payload = data[position + 8:position + 8 + length]
        crc = struct.unpack(">I", data[position + 8 + length:stop])[0]
        if (binascii.crc32(kind + payload) & 0xFFFFFFFF) != crc:
            raise ValueError("PNG CRC mismatch")
        if kind == b"IHDR":
            if header or position != 8 or length != 13:
                raise ValueError("Invalid PNG header")
            if struct.unpack(">IIBBBBB", payload) != (size, size, 8, 6, 0, 0, 0):
                raise ValueError("Expected square RGBA8 non-interlaced image")
            header = True
        elif kind == b"IDAT":
            if not header:
                raise ValueError("PNG image data precedes header")
            compressed.extend(payload)
        elif kind == b"IEND":
            if payload or stop != len(data):
                raise ValueError("Invalid PNG ending")
            end = True
        else:
            raise ValueError("Unexpected PNG metadata; linear bake must contain no display colour profile")
        position = stop
    if not header or not end or not compressed:
        raise ValueError("Incomplete PNG")
    expected = size * (size * 4 + 1)
    decoder = zlib.decompressobj()
    raw = decoder.decompress(compressed, expected + 1)
    if len(raw) != expected or not decoder.eof or decoder.unconsumed_tail or decoder.unused_data:
        raise ValueError("Invalid or excessive decompressed PNG data")
    stride = size * 4 + 1
    nonzero = False
    for y in range(size):
        if raw[y * stride] != 0:
            raise ValueError("Expected exact encoder's row-zero filter convention")
        row = raw[y * stride + 1:(y + 1) * stride]
        if any(alpha != 255 for alpha in row[3::4]):
            raise ValueError("Bake alpha must be fully opaque")
        nonzero = nonzero or any(value for i, value in enumerate(row) if i % 4 != 3)
    if not nonzero:
        raise ValueError("Bake contains no visible RGB illumination")


def validate_result(source: Path, scene_path: Path) -> dict:
    payload = scene_path.read_bytes()
    if not 0 < len(payload) <= MAX_INPUT_BYTES:
        raise ValueError("Scene exceeds bounded input size")
    scene = json.loads(payload)
    manifest_data = (source / "manifest.json").read_bytes()
    if len(manifest_data) > 64 * 1024:
        raise ValueError("Manifest exceeds bounded size")
    manifest = json.loads(manifest_data)
    size = manifest.get("width")
    samples = manifest.get("samples")
    if size not in (512, 1024) or samples != 128:
        raise ValueError("Install only a 512/1024-square 128-sample reference")
    validate_scene(scene, size, samples)
    required_sources = ("tools/bake/export-market-neon.mjs", "tools/bake/market_neon_bake.py", "tools/bake/courtyard_bake.py")
    if any(name not in scene["sourceFingerprints"] for name in required_sources):
        raise ValueError("Missing exporter/baker source provenance")
    for name, expected_hash in scene["sourceFingerprints"].items():
        path = (ROOT / name).resolve()
        if not path.is_relative_to(ROOT.resolve()) or not path.is_file():
            raise ValueError("Source fingerprint points outside isolated checkout")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
            raise ValueError(f"Source changed since export: {name}; re-export and rebake")
    expected = {key: scene[key] for key in ("version", "kind", "sceneHash", "layoutHash", "bounds", "receiverY", "occlusionPadding", "emitters", "geometryFingerprint", "lightingFingerprint", "sourceFingerprints", "limitations")}
    expected.update(file=PNG_FILE, height=size, radianceScale=16, encoding=ENCODING,
                    inputSha256=hashlib.sha256(payload).hexdigest())
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise ValueError("Manifest does not match staged scene or linear-light contract")
    device = manifest.get("device")
    devices = manifest.get("gpuDevices")
    if device not in ("CPU", "CUDA") or not isinstance(devices, list) or any(not isinstance(d, str) or not d for d in devices):
        raise ValueError("Missing device provenance")
    if (device == "CPU" and devices) or (device == "CUDA" and not devices):
        raise ValueError("Device provenance contradicts GPU list")
    metrics = manifest.get("metrics")
    pixels = metrics.get("pixels") if isinstance(metrics, dict) else None
    if not isinstance(pixels, dict) or any(type(pixels.get(k)) not in (int, float) or not math.isfinite(pixels[k]) for k in ("min", "max", "mean", "nonzeroChannels", "clippedChannels")):
        raise ValueError("Non-finite or missing pixel metrics")
    if not (0 <= pixels["min"] <= pixels["mean"] <= pixels["max"] <= 16 and pixels["nonzeroChannels"] > 0 and pixels["clippedChannels"] == 0):
        raise ValueError("Black, clipped or contradictory pixel metrics")
    if metrics.get("meshes") != len(scene["meshes"]) or metrics.get("triangles") != sum(len(m["indices"]) // 3 for m in scene["meshes"]):
        raise ValueError("Bake geometry metrics contradict scene")
    if type(metrics.get("elapsedSeconds")) not in (int, float) or not math.isfinite(metrics["elapsedSeconds"]) or not 0 < metrics["elapsedSeconds"] <= 600:
        raise ValueError("Invalid bounded elapsed bake duration")
    data = (source / PNG_FILE).read_bytes()
    validate_png(data, size)
    if metrics.get("pngBytes") != len(data) or manifest.get("textureHash") != hashlib.sha256(data).hexdigest():
        raise ValueError("Texture size or fingerprint mismatch")
    return manifest


def require_isolated_branch() -> None:
    dot_git = ROOT / ".git"
    # An original checkout (.git directory, where the lead installs on main) or a linked
    # worktree (.git file pointing at its gitdir). A copied directory has neither.
    if dot_git.is_dir():
        gitdir = dot_git.resolve()
    elif dot_git.is_file():
        record = dot_git.read_text(encoding="utf-8").strip()
        if not record.startswith("gitdir: "):
            raise ValueError("Invalid linked worktree pointer")
        gitdir = (ROOT / record[8:]).resolve()
    else:
        raise ValueError("Installer requires a git checkout, not a copied directory")
    native = Path("C:/Program Files/Git/cmd/git.exe")
    git = str(native) if native.is_file() else shutil.which("git")
    if not git:
        raise ValueError("Git required for isolated-branch verification")
    branch = subprocess.run([git, "-c", f"safe.directory={ROOT.as_posix()}", f"--git-dir={gitdir}",
                             f"--work-tree={ROOT}", "symbolic-ref", "--short", "HEAD"],
                            cwd=ROOT, text=True, capture_output=True, check=True).stdout.strip()
    # Kiran (2026-10-13): installs run on main (the lead bakes there) or the Codex staging branch.
    if branch not in ("main", "codex/isolated-finish"):
        raise ValueError(f"Refusing install on branch {branch!r}")


def install(source: Path, scene_path: Path) -> None:
    require_isolated_branch()
    manifest = validate_result(source, scene_path)
    target = ROOT / "packages/client/public/lightmaps/market-neon-pilot"
    runtime_path = ROOT / "packages/client/src/render/marketNeonBakeManifest.ts"
    if not target.resolve().is_relative_to(ROOT.resolve()) or not runtime_path.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError("Installation target escapes isolated checkout")
    keys = ("version", "kind", "sceneHash", "layoutHash", "bounds", "receiverY", "file", "textureHash", "width", "height",
            "radianceScale", "encoding", "emitters", "geometryFingerprint", "lightingFingerprint", "inputSha256", "sourceFingerprints", "device")
    runtime = {key: manifest[key] for key in keys}
    data = (source / PNG_FILE).read_bytes()
    if hashlib.sha256(data).hexdigest() != manifest["textureHash"]:
        raise ValueError("Staged image changed during validation")
    target.mkdir(parents=True, exist_ok=True)
    (target / PNG_FILE).write_bytes(data)
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    runtime_path.write_text("// Generated by tools/bake/install_market_neon.py; isolated landmark reference.\n"
                            + "export const MARKET_NEON_BAKE = " + json.dumps(runtime, indent=2) + " as const;\n", encoding="utf-8")
    print(f"Installed {manifest['width']}px {manifest['device']} reference ({manifest['metrics']['pngBytes']} bytes) on codex/isolated-finish")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--scene", type=Path, required=True)
    args = parser.parse_args()
    install(args.source.resolve(), args.scene.resolve())
