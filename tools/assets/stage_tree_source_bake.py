"""Validate browser-baked tree candidates and encode them in a separate staging directory."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

from webp import save_webp
from shrink_tree_impostor import resize_normal_atlas

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "packages/client/public/models/trees"
FRAME = 256
SHIPPED_FRAME = 128
FRAMES = 8
BYTES = FRAME * FRAME * FRAMES * 4


def validate_candidate(bundle: dict, species: str, manifest: dict) -> tuple[Image.Image, Image.Image, dict]:
    receipt = bundle["receipt"]
    info = manifest["species"][species]
    if (receipt["id"] != species or receipt["output"] != [FRAME * FRAMES, FRAME]
            or receipt["inputSize"] != 1024 or receipt["frame"] != info["frame"]
            or receipt["triangleCounts"] != info["triangles"] or len(receipt["checks"]) != 8):
        raise ValueError("Tree layout, source mesh or reduction checks differ")
    expected_paths = {
        f"/models/trees/{species}.glb", "/models/trees/trees.json",
        f"/models/trees/bark_{info['bark']}_color.webp",
        f"/models/trees/leaf_{info['leaf']}.webp", f"/models/trees/{species}_impostor.webp",
    }
    fingerprints = receipt["sourceFingerprints"]
    if set(fingerprints) != expected_paths:
        raise ValueError("Missing or unexpected source provenance")
    for name, digest in fingerprints.items():
        path = ASSETS / name.removeprefix("/models/trees/")
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError(f"Source changed after bake: {name}")
    if receipt["sourceGlbSha256"] != fingerprints[f"/models/trees/{species}.glb"]:
        raise ValueError("GLB provenance differs")
    if (receipt["ao"]["minimum"] != 0.65 or receipt["ao"]["directLightBaked"]
            or receipt["ao"]["receiverPlane"] or receipt["adoptedInProduction"]):
        raise ValueError("Unsupported candidate occlusion/lighting contract")
    color_bytes = base64.b64decode(bundle["colorRGBA"], validate=True)
    normal_bytes = base64.b64decode(bundle["normalAoRGBA"], validate=True)
    if len(color_bytes) != BYTES or len(normal_bytes) != BYTES:
        raise ValueError("Candidate pixel dimensions differ")
    color = np.frombuffer(color_bytes, np.uint8).reshape(FRAME, FRAME * FRAMES, 4)
    normal = np.frombuffer(normal_bytes, np.uint8).reshape(color.shape)
    covered = color[:, :, 3] > 0
    if not covered.any() or np.min(normal[:, :, 3][covered]) < round(0.65 * 255):
        raise ValueError("Candidate has no silhouette or excessive occlusion")
    if np.any(normal[:, :, 3][~covered] != 255):
        raise ValueError("Empty texels must have neutral occlusion")
    vectors = normal[:, :, :3].astype(np.float64) / 255 * 2 - 1
    error = float(np.max(np.abs(np.linalg.norm(vectors[covered], axis=1) - 1)))
    if error > 0.014:
        raise ValueError("Candidate normals are not unit vectors")
    if len(receipt["views"]) != FRAMES or len(receipt["references"]) != FRAMES:
        raise ValueError("Missing per-view comparisons")
    bounds_error = 0
    ratios = []
    for frame, (view, reference) in enumerate(zip(receipt["views"], receipt["references"], strict=True)):
        pixels = color[:, frame * FRAME:(frame + 1) * FRAME, 3]
        ys, xs = np.where(pixels >= 128)
        if not len(xs) or len(xs) != view["covered"]:
            raise ValueError("Per-view silhouette receipt differs")
        bounds = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
        if bounds != view["bounds"]:
            raise ValueError("Per-view framing receipt differs")
        bounds_error = max(bounds_error, max(abs(a - b) for a, b in zip(bounds, reference["bounds"], strict=True)))
        ratios.append(view["covered"] / reference["covered"])
    if bounds_error > 2:
        raise ValueError("Tree framing drift exceeds two output pixels")
    summary = {"species": species, "maxNormalLengthError": error,
               "maxReferenceBoundsErrorPixels": bounds_error, "coverageRatiosTo1x": ratios,
               "meanCoveredAO": float(np.mean(normal[:, :, 3][covered]) / 255)}
    return Image.frombytes("RGBA", (FRAME * FRAMES, FRAME), color_bytes), Image.frombytes(
        "RGBA", (FRAME * FRAMES, FRAME), normal_bytes), summary


def stage(candidates: Path, output: Path) -> dict:
    candidates, output = candidates.resolve(), output.resolve()
    if not output.is_relative_to(ROOT / "tools/assets/build"):
        raise ValueError("Staging output must remain under tools/assets/build")
    manifest = json.loads((ASSETS / "trees.json").read_text())
    verified = []
    for species in ("ash", "oak", "pine"):
        path = candidates / f"{species}-candidate.json"
        if path.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("Candidate bundle exceeds bounded input size")
        verified.append(validate_candidate(json.loads(path.read_text()), species, manifest))
    output.mkdir(parents=True, exist_ok=True)
    summaries = []
    for color, normal, summary in verified:
        species = summary["species"]
        outputs = []
        shipped = {
            "_impostor": color,
            "_impostor_n": resize_normal_atlas(normal, color, SHIPPED_FRAME),
        }
        for suffix, kind in (("_impostor", "color"), ("_impostor_n", "lossless")):
            image = shipped[suffix]
            path = save_webp(image, output / f"{species}{suffix}.webp", kind)
            decoded = Image.open(path).convert("RGBA")
            if not np.array_equal(np.asarray(decoded)[:, :, 3], np.asarray(image)[:, :, 3]):
                raise ValueError("WebP encoding changed alpha data")
            if kind == "lossless" and not np.array_equal(np.asarray(decoded), np.asarray(image)):
                raise ValueError("Normal/AO encoding changed data")
            outputs.append({"path": str(path), "bytes": path.stat().st_size,
                            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        summary["outputs"] = outputs
        summaries.append(summary)
    result = {"scope": "Candidate assets only; not installed or AAA-accepted", "species": summaries}
    (output / "receipt.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", type=Path, default=ROOT / "tools/assets/build/tree-source-bake")
    parser.add_argument("--out", type=Path, default=ROOT / "tools/assets/build/tree-source-staged")
    args = parser.parse_args()
    print(json.dumps(stage(args.candidates, args.out), indent=2))
