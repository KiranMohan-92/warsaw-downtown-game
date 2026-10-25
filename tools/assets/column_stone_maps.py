"""Build bounded PBR data maps from the approved AI-authored column colour source.

Colour is retained as an independent material channel: these are inferred relief maps,
not photogrammetric measurements or a baked render of a finished column. Run locally;
no cloud account or Blender session is needed. Only this checkout's versioned assets change.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np
from PIL import Image, ImageFilter

from webp import save_webp

REPO_ROOT = Path(__file__).resolve().parents[2]
MAX_SOURCE_EDGE = 4096
FACADE_SANDSTONE_SRGB = np.array([0xE6, 0xD8, 0xBF], dtype=np.float64) / 255


def blur_channel(channel: np.ndarray, radius: float) -> np.ndarray:
    """Tile-aware Gaussian filtering avoids a discontinuity in inferred normals."""
    pad = max(2, int(radius * 4))
    padded = np.pad(channel, pad, mode="wrap")
    encoded = Image.fromarray(np.round(np.clip(padded, 0, 1) * 255).astype(np.uint8))
    blurred = np.asarray(encoded.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32)
    return blurred[pad:-pad, pad:-pad] / 255


def data_maps(rgb: np.ndarray, tile_metres: tuple[float, float] = (1.35, 2.2)) -> dict[str, np.ndarray]:
    """Infer millimetre-scale pores and fine relief without turning veins into deep cracks."""
    luma = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    fine = blur_channel(luma, 0.6)
    broad = blur_channel(luma, 7.0)
    relief = np.clip(fine - broad, -0.24, 0.12)
    # Pores are modest recesses, not centimetre-scale displacement or specular glitter.
    pores = np.clip((broad - fine - 0.035) * 4.0, 0.0, 0.8)
    height = relief * 0.003 - pores * 0.0012
    h, w = luma.shape
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) / (2 * tile_metres[0] / w)
    # Pixel rows run downward; OpenGL tangent-space green points upward.
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) / (2 * tile_metres[1] / h)
    vectors = np.stack([-dx, dy, np.ones_like(dx)], axis=2)
    vectors /= np.linalg.norm(vectors, axis=2, keepdims=True)
    normal = np.round((vectors * 0.5 + 0.5) * 255).astype(np.uint8)
    roughness = np.clip(0.72 + pores * 0.20 - relief * 0.32, 0.65, 0.94)
    # Pack neutral AO, roughness and dielectric metalness; one image can supply both maps.
    orm = np.stack([1 - pores * 0.18, roughness, np.zeros_like(luma)], axis=2)
    return {"normal": normal, "orm": np.round(orm * 255).astype(np.uint8)}


def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)


def normalise_albedo_mean(rgb: np.ndarray, target: np.ndarray = FACADE_SANDSTONE_SRGB) -> np.ndarray:
    """Match mean albedo in the renderer's linear space, retaining local texture variation."""
    linear = srgb_to_linear(np.asarray(rgb, dtype=np.float64))
    gain = srgb_to_linear(target) / np.maximum(linear.mean(axis=(0, 1)), 1e-6)
    matched = np.clip(linear * gain, 0.0, 1.0)
    return np.where(matched <= 0.0031308, matched * 12.92, 1.055 * matched ** (1 / 2.4) - 0.055)


def build(source: Path, output: Path, size: int = 1024) -> dict:
    if size not in (256, 512, 1024, 2048):
        raise ValueError("Texture size must be 256, 512, 1024 or 2048")
    started = time.perf_counter()
    with Image.open(source) as original:
        source_size = original.size
        if min(source_size) < size or max(source_size) > MAX_SOURCE_EDGE:
            raise ValueError("Do not upscale colour detail or accept an unbounded source")
        colour = original.convert("RGB").resize((size, size), Image.Resampling.LANCZOS)
    source_rgb = np.asarray(colour, dtype=np.float32) / 255
    filtered = colour.filter(ImageFilter.GaussianBlur(0.5))
    albedo = Image.fromarray(np.round(normalise_albedo_mean(np.asarray(filtered) / 255) * 255).astype(np.uint8))
    output.mkdir(parents=True, exist_ok=True)
    save_webp(albedo, output / "stone_albedo.webp", "color", match_jpeg=85)
    # Match the renderer's sRGB decode before averaging: mip filtering and material
    # multiplication operate in linear light. Measure the encoded asset, not its source.
    with Image.open(output / "stone_albedo.webp") as encoded:
        srgb = np.asarray(encoded.convert("RGB"), dtype=np.float64) / 255
    linear = srgb_to_linear(srgb)
    albedo_mean = linear.mean(axis=(0, 1)).tolist()
    for name, pixels in data_maps(source_rgb).items():
        image = Image.fromarray(pixels).filter(ImageFilter.MedianFilter(3)).filter(ImageFilter.GaussianBlur(2.0))
        save_webp(image, output / f"stone_{name}.webp", "data")
    files = {}
    for name in ("albedo", "normal", "orm"):
        file = output / f"stone_{name}.webp"
        files[file.name] = {"bytes": file.stat().st_size, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
    manifest = {
        "sourceKind": "AI-authored base colour; inferred relief, roughness and cavity data",
        "sourceSize": source_size,
        "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "size": size,
        "tileMetres": [1.35, 2.2],
        "normalConvention": "OpenGL tangent space, positive green upward",
        "ormChannels": {
            "r": "local pore occlusion",
            "g": "roughness",
            "b": "unused; zero before lossy WebP encode",
        },
        "colourSpace": {"albedo": "sRGB", "normal": "linear", "orm": "linear"},
        "albedoMeanLinear": albedo_mean,
        "albedoPalette": "#e6d8bf",
        "filters": {"albedo": "gaussian 0.5 px", "normal": "median 3 px then gaussian 2 px", "orm": "median 3 px then gaussian 2 px"},
        "bytes": sum(f["bytes"] for f in files.values()),
        "estimatedRGBA8GpuBytesWithMipmaps": size * size * 4 * 4,
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "files": files,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "packages/client/public/tex/palace-columns-v2")
    parser.add_argument("--size", type=int, default=1024)
    args = parser.parse_args()
    print(json.dumps(build(args.source.resolve(), args.out.resolve(), args.size), indent=2))


if __name__ == "__main__":
    main()
